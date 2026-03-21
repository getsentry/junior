import { Message, ThreadImpl } from "chat";
import type {
  Message as ChatMessage,
  SerializedMessage,
  SerializedThread,
  Thread,
} from "chat";
import { logError, logInfo, logWarn } from "@/chat/observability";
import { removeReactionFromMessage } from "@/chat/slack-actions/channel";
import {
  acquireQueueMessageProcessingOwnership,
  completeQueueMessageProcessingOwnership,
  failQueueMessageProcessingOwnership,
  getStateAdapter,
  getQueueMessageProcessingState,
  refreshQueueMessageProcessingOwnership,
} from "@/chat/state";
import { processThreadMessageRuntime } from "@/chat/thread-runtime/process-thread-message-runtime";
import type { ThreadMessagePayload } from "@/chat/queue/types";

let stateAdapterConnected = false;

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

interface ProcessQueuedThreadMessageDeps {
  clearProcessingReaction: (input: {
    channelId: string;
    timestamp: string;
  }) => Promise<void>;
  logInfo: typeof logInfo;
  logWarn: typeof logWarn;
  processRuntime: typeof processThreadMessageRuntime;
}

const defaultProcessQueuedThreadMessageDeps: ProcessQueuedThreadMessageDeps = {
  clearProcessingReaction: async ({ channelId, timestamp }) => {
    await removeReactionFromMessage({
      channelId,
      timestamp,
      emoji: "eyes",
    });
  },
  logInfo,
  logWarn,
  processRuntime: processThreadMessageRuntime,
};

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
  deps: ProcessQueuedThreadMessageDeps = defaultProcessQueuedThreadMessageDeps,
): Promise<void> {
  const existingMessageState = await getQueueMessageProcessingState(
    payload.dedupKey,
  );
  if (existingMessageState?.status === "completed") {
    deps.logInfo(
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

  const ownerToken = createMessageOwnerToken();
  const claimResult = await acquireQueueMessageProcessingOwnership({
    rawKey: payload.dedupKey,
    ownerToken,
    queueMessageId: payload.queueMessageId,
  });

  if (claimResult === "blocked") {
    deps.logInfo(
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

  const threadWasSerialized = isSerializedThread(payload.thread);

  if (threadWasSerialized && !stateAdapterConnected) {
    await getStateAdapter().connect();
    stateAdapterConnected = true;
  }

  const runtimePayload = {
    ...payload,
    thread: deserializeThread(payload.thread),
    message: deserializeMessage(payload.message),
  };
  let reactionCleared = false;
  const clearProcessingReaction = async (): Promise<void> => {
    if (reactionCleared) {
      return;
    }
    reactionCleared = true;
    try {
      await deps.clearProcessingReaction({
        channelId: runtimePayload.thread.channelId,
        timestamp: runtimePayload.message.id,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      deps.logWarn(
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

    await deps.processRuntime({
      kind: runtimePayload.kind,
      thread: runtimePayload.thread,
      message: runtimePayload.message,
      preApprovedDecision: runtimePayload.preApprovedDecision,
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
    const errorMessage = error instanceof Error ? error.message : String(error);
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
}
