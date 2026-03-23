import { Message, ThreadImpl } from "chat";
import type {
  Lock,
  Message as ChatMessage,
  SerializedMessage,
  SerializedThread,
  Thread,
} from "chat";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { logError, logInfo, logWarn } from "@/chat/logging";
import { DeferredThreadMessageError } from "@/chat/queue/errors";
import type { ThreadMessageDispatcher } from "@/chat/queue/thread-message-dispatcher";
import { removeReactionFromMessage } from "@/chat/slack/channel";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  acquireQueueMessageProcessingOwnership,
  completeQueueMessageProcessingOwnership,
  failQueueMessageProcessingOwnership,
  getQueueMessageProcessingState,
  refreshQueueMessageProcessingOwnership,
} from "@/chat/state/queue-processing-store";
import type { ThreadMessagePayload } from "@/chat/queue/types";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";

const THREAD_PROCESSING_LOCK_TTL_MS = 5 * 60 * 1000;
const THREAD_PROCESSING_LOCK_HEARTBEAT_MS = 60 * 1000;

function isSerializedThread(
  thread: ThreadMessagePayload["thread"],
): thread is SerializedThread {
  return (
    typeof thread === "object" &&
    thread !== null &&
    (thread as { _type?: unknown })._type === "chat:Thread"
  );
}

function isSerializedMessage(
  message: ThreadMessagePayload["message"],
): message is SerializedMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { _type?: unknown })._type === "chat:Message"
  );
}

function getPayloadChannelId(payload: {
  thread: ThreadMessagePayload["thread"];
}): string | undefined {
  return payload.thread.channelId;
}

function getPayloadUserId(payload: {
  message: ThreadMessagePayload["message"];
}): string | undefined {
  return payload.message.author?.userId;
}

function createMessageOwnerToken(): string {
  return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class QueueMessageOwnershipError extends Error {
  constructor(stage: "refresh" | "complete", dedupKey: string) {
    super(
      `Queue message ownership lost during ${stage} for dedupKey=${dedupKey}`,
    );
    this.name = "QueueMessageOwnershipError";
  }
}

interface ProcessMessageDeps {
  clearProcessingReaction?: (input: {
    channelId: string;
    timestamp: string;
  }) => Promise<void>;
  dispatch: ThreadMessageDispatcher;
  logInfo?: typeof logInfo;
  logWarn?: typeof logWarn;
}

const defaultProcessQueuedThreadMessageDeps = {
  clearProcessingReaction: async ({
    channelId,
    timestamp,
  }: {
    channelId: string;
    timestamp: string;
  }) => {
    await removeReactionFromMessage({
      channelId,
      timestamp,
      emoji: "eyes",
    });
  },
  logInfo,
  logWarn,
};

function resolveDeps(deps: ProcessMessageDeps): Required<ProcessMessageDeps> {
  return {
    ...defaultProcessQueuedThreadMessageDeps,
    ...deps,
  };
}

function deserializeThread(thread: ThreadMessagePayload["thread"]): Thread {
  if (isSerializedThread(thread)) {
    return ThreadImpl.fromJSON(thread);
  }

  return thread;
}

function deserializeMessage(
  message: ThreadMessagePayload["message"],
): ChatMessage {
  if (isSerializedMessage(message)) {
    return Message.fromJSON(message);
  }

  return message;
}

export async function logThreadMessageFailure(
  payload: ThreadMessagePayload,
  errorMessage: string,
): Promise<void> {
  logError(
    "queue_message_failed",
    {
      slackThreadId: payload.normalizedThreadId,
      slackChannelId: getPayloadChannelId(payload),
      slackUserId: getPayloadUserId(payload),
    },
    {
      "messaging.message.id": payload.message.id,
      "app.queue.message_kind": payload.kind,
      "app.queue.message_id": payload.queueMessageId,
      "error.message": errorMessage,
    },
    "Queue message processing failed",
  );
}

export async function processQueuedThreadMessage(
  payload: ThreadMessagePayload,
  deps: ProcessMessageDeps,
): Promise<void> {
  const resolvedDeps = resolveDeps(deps);
  const existingMessageState = await getQueueMessageProcessingState(
    payload.dedupKey,
  );
  if (existingMessageState?.status === "completed") {
    resolvedDeps.logInfo(
      "queue_message_skipped_completed",
      {
        slackThreadId: payload.normalizedThreadId,
        slackChannelId: getPayloadChannelId(payload),
        slackUserId: getPayloadUserId(payload),
      },
      {
        "messaging.message.id": payload.message.id,
        "app.queue.message_kind": payload.kind,
        "app.queue.message_id": payload.queueMessageId,
        "app.queue.processing_state": existingMessageState.status,
      },
      "Skipping queue message because it is already completed",
    );
    return;
  }

  const state = getStateAdapter();
  await state.connect();
  const threadLock = await state.acquireLock(
    payload.normalizedThreadId,
    THREAD_PROCESSING_LOCK_TTL_MS,
  );
  if (!threadLock) {
    resolvedDeps.logInfo(
      "queue_message_deferred_thread_locked",
      {
        slackThreadId: payload.normalizedThreadId,
        slackChannelId: getPayloadChannelId(payload),
        slackUserId: getPayloadUserId(payload),
      },
      {
        "messaging.message.id": payload.message.id,
        "app.queue.message_kind": payload.kind,
        "app.queue.message_id": payload.queueMessageId,
      },
      "Deferring queue message because another turn already owns the thread lock",
    );
    throw new DeferredThreadMessageError(
      "thread_locked",
      payload.normalizedThreadId,
    );
  }

  const threadLockHeartbeat = startThreadLockHeartbeat({
    lock: threadLock,
    state,
    payload,
    logWarn: resolvedDeps.logWarn,
  });

  try {
    const runtimePayload = {
      ...payload,
      thread: deserializeThread(payload.thread),
      message: deserializeMessage(payload.message),
    };
    const currentTurnId = buildDeterministicTurnId(runtimePayload.message.id);
    const activeTurnId = coerceThreadConversationState(
      await runtimePayload.thread.state,
    ).processing.activeTurnId;
    if (activeTurnId && activeTurnId !== currentTurnId) {
      resolvedDeps.logInfo(
        "queue_message_deferred_active_turn",
        {
          slackThreadId: payload.normalizedThreadId,
          slackChannelId: getPayloadChannelId(payload),
          slackUserId: getPayloadUserId(payload),
        },
        {
          "messaging.message.id": payload.message.id,
          "app.queue.message_kind": payload.kind,
          "app.queue.message_id": payload.queueMessageId,
          "app.thread.active_turn_id": activeTurnId,
          "app.thread.current_turn_id": currentTurnId,
        },
        "Deferring queue message because another turn is still active for the thread",
      );
      throw new DeferredThreadMessageError(
        "active_turn",
        payload.normalizedThreadId,
        {
          activeTurnId,
          currentTurnId,
        },
      );
    }

    const ownerToken = createMessageOwnerToken();
    const claimResult = await acquireQueueMessageProcessingOwnership({
      rawKey: payload.dedupKey,
      ownerToken,
      queueMessageId: payload.queueMessageId,
    });

    if (claimResult === "blocked") {
      resolvedDeps.logInfo(
        "queue_message_skipped_blocked",
        {
          slackThreadId: payload.normalizedThreadId,
          slackChannelId: getPayloadChannelId(payload),
          slackUserId: getPayloadUserId(payload),
        },
        {
          "messaging.message.id": payload.message.id,
          "app.queue.message_kind": payload.kind,
          "app.queue.message_id": payload.queueMessageId,
          "app.queue.claim_result": claimResult,
          "app.queue.processing_state": "processing",
        },
        "Skipping queue message because another worker owns it",
      );
      return;
    }

    let reactionCleared = false;
    const clearProcessingReaction = async (): Promise<void> => {
      if (reactionCleared) {
        return;
      }
      reactionCleared = true;
      try {
        await resolvedDeps.clearProcessingReaction({
          channelId: runtimePayload.thread.channelId,
          timestamp: runtimePayload.message.id,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        resolvedDeps.logWarn(
          "queue_processing_reaction_clear_failed",
          {
            slackThreadId: payload.normalizedThreadId,
            slackChannelId: getPayloadChannelId(payload),
            slackUserId: getPayloadUserId(payload),
          },
          {
            "messaging.message.id": payload.message.id,
            "app.queue.message_kind": payload.kind,
            "app.queue.message_id": payload.queueMessageId,
            "error.message": errorMessage,
          },
          "Failed to remove processing reaction after queue turn completion",
        );
      }
    };

    try {
      const refreshed = await refreshQueueMessageProcessingOwnership({
        rawKey: payload.dedupKey,
        ownerToken,
        queueMessageId: payload.queueMessageId,
      });

      if (!refreshed) {
        throw new QueueMessageOwnershipError("refresh", payload.dedupKey);
      }

      await resolvedDeps.dispatch({
        kind: runtimePayload.kind,
        thread: runtimePayload.thread,
        message: runtimePayload.message,
      });
      await clearProcessingReaction();

      const completed = await completeQueueMessageProcessingOwnership({
        rawKey: payload.dedupKey,
        ownerToken,
        queueMessageId: payload.queueMessageId,
      });

      if (!completed) {
        throw new QueueMessageOwnershipError("complete", payload.dedupKey);
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await clearProcessingReaction();

      await logThreadMessageFailure(payload, errorMessage);

      const failed = await failQueueMessageProcessingOwnership({
        rawKey: payload.dedupKey,
        ownerToken,
        errorMessage,
        queueMessageId: payload.queueMessageId,
      });

      if (!failed && !(error instanceof QueueMessageOwnershipError)) {
        throw new Error(
          `Failed to persist queue message failure state for dedupKey=${payload.dedupKey}: ${errorMessage}`,
        );
      }

      throw error;
    }
  } finally {
    await threadLockHeartbeat.stop();
  }
}

function startThreadLockHeartbeat(args: {
  lock: Lock;
  state: ReturnType<typeof getStateAdapter>;
  payload: ThreadMessagePayload;
  logWarn: typeof logWarn;
}): {
  stop: () => Promise<void>;
} {
  const interval = setInterval(() => {
    void args.state
      .extendLock(args.lock, THREAD_PROCESSING_LOCK_TTL_MS)
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        args.logWarn(
          "queue_thread_lock_extend_failed",
          {
            slackThreadId: args.payload.normalizedThreadId,
            slackChannelId: getPayloadChannelId(args.payload),
            slackUserId: getPayloadUserId(args.payload),
          },
          {
            "messaging.message.id": args.payload.message.id,
            "app.queue.message_kind": args.payload.kind,
            "app.queue.message_id": args.payload.queueMessageId,
            "error.message": errorMessage,
          },
          "Failed to extend thread-processing lock during queue execution",
        );
      });
  }, THREAD_PROCESSING_LOCK_HEARTBEAT_MS);
  interval.unref?.();

  return {
    stop: async () => {
      clearInterval(interval);
      await args.state.releaseLock(args.lock);
    },
  };
}
