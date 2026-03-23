import type { Message, Thread } from "chat";
import {
  logInfo,
  logWarn,
  setSpanAttributes,
  withContext,
  withSpan,
} from "@/chat/observability";
import { enqueueThreadMessage as enqueueThreadMessageImpl } from "@/chat/queue/client";
import type {
  ThreadMessageKind,
  ThreadMessagePayload,
} from "@/chat/queue/types";
import {
  addReactionToMessage,
  removeReactionFromMessage,
} from "@/chat/slack-actions/channel";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  claimQueueIngressDedup,
  hasQueueIngressDedup,
} from "@/chat/state/queue-ingress-store";

// Keep ingress dedupe keys long enough to cover delayed Slack retries.
export const QUEUE_INGRESS_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

export type QueueIngressRouteResult =
  | "ignored_non_object"
  | "ignored_self_message"
  | "ignored_missing_message_id"
  | "ignored_unsubscribed_non_mention"
  | "ignored_duplicate"
  | "routed";

export interface QueueRoutingRuntime {
  createThread: (
    adapter: unknown,
    threadId: string,
    initialMessage: unknown,
    isSubscribedContext?: boolean,
  ) => Promise<unknown>;
  detectMention?: (adapter: unknown, message: unknown) => boolean;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function serializeMessageForQueue(
  message: Message,
): ThreadMessagePayload["message"] {
  const candidate = message as Message & { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON() as ThreadMessagePayload["message"];
  }

  return {
    _type: "chat:Message",
    ...(message as unknown as Record<string, unknown>),
  } as ThreadMessagePayload["message"];
}

function serializeThreadForQueue(
  thread: Thread,
): ThreadMessagePayload["thread"] {
  const candidate = thread as Thread & { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON() as ThreadMessagePayload["thread"];
  }

  return {
    _type: "chat:Thread",
    ...(thread as unknown as Record<string, unknown>),
  } as ThreadMessagePayload["thread"];
}

// Derive canonical Slack thread IDs from the raw event payload (channel + thread_ts/ts)
// rather than trusting adapter-provided thread ID parts which may be incomplete.
export function normalizeIncomingSlackThreadId(
  threadId: string,
  message: unknown,
): string {
  if (!threadId.startsWith("slack:")) {
    return threadId;
  }

  if (!message || typeof message !== "object") {
    return threadId;
  }

  const raw = (message as { raw?: Record<string, unknown> }).raw;
  if (!raw || typeof raw !== "object") {
    return threadId;
  }

  const channelId = nonEmptyString(raw.channel);
  const threadTs = nonEmptyString(raw.thread_ts) ?? nonEmptyString(raw.ts);
  if (!channelId || !threadTs) {
    return threadId;
  }

  return `slack:${channelId}:${threadTs}`;
}

export function buildQueueIngressDedupKey(
  normalizedThreadId: string,
  messageId: string,
): string {
  return `${normalizedThreadId}:${messageId}`;
}

function isSlackDirectMessageThreadId(threadId: string): boolean {
  const parts = threadId.split(":");
  return (
    parts.length === 3 && parts[0] === "slack" && parts[1]?.startsWith("D")
  );
}

export function determineThreadMessageKind(args: {
  isDirectMessage: boolean;
  isMention: boolean;
  isSubscribed: boolean;
}): ThreadMessageKind | undefined {
  if (args.isDirectMessage) {
    return "new_mention";
  }

  if (args.isSubscribed) {
    return "subscribed_message";
  }

  if (args.isMention) {
    return "new_mention";
  }

  return undefined;
}

function getMessageLogContext(args: {
  message: {
    author?: { userId?: string };
    raw?: Record<string, unknown>;
  };
  normalizedThreadId?: string;
}): {
  slackChannelId?: string;
  slackThreadId?: string;
  slackUserId?: string;
} {
  return {
    slackThreadId: args.normalizedThreadId,
    slackChannelId: nonEmptyString(args.message.raw?.channel),
    slackUserId: args.message.author?.userId,
  };
}

function logIgnoredIngressResult(args: {
  eventName: string;
  logContext: {
    slackChannelId?: string;
    slackThreadId?: string;
    slackUserId?: string;
  };
  messageId?: string;
  dedupKey?: string;
  kind?: ThreadMessageKind;
  routeResult: QueueIngressRouteResult;
  decisionReason?: string;
  body: string;
}): void {
  logInfo(
    args.eventName,
    args.logContext,
    {
      ...(args.messageId ? { "messaging.message.id": args.messageId } : {}),
      ...(args.kind ? { "app.queue.message_kind": args.kind } : {}),
      ...(args.dedupKey ? { "app.queue.dedup_key": args.dedupKey } : {}),
      ...(args.decisionReason
        ? { "app.decision.reason": args.decisionReason }
        : {}),
      "app.queue.route_result": args.routeResult,
    },
    args.body,
  );
}

async function enqueueQueueIngressMessage(args: {
  dedupKey: string;
  enqueueThreadMessage?: (
    payload: ThreadMessagePayload,
    dedupKey: string,
  ) => Promise<string | undefined>;
  payload: ThreadMessagePayload;
}): Promise<string | undefined> {
  if (args.enqueueThreadMessage) {
    return await args.enqueueThreadMessage(args.payload, args.dedupKey);
  }
  return await enqueueThreadMessageImpl(args.payload, {
    idempotencyKey: args.dedupKey,
  });
}

export async function routeIncomingMessageToQueue(args: {
  adapter: unknown;
  enqueueThreadMessage?: (
    payload: ThreadMessagePayload,
    dedupKey: string,
  ) => Promise<string | undefined>;
  message: unknown;
  runtime: QueueRoutingRuntime;
  threadId: string;
}): Promise<QueueIngressRouteResult> {
  const { adapter, runtime } = args;
  const message = args.message;
  if (!message || typeof message !== "object") {
    return "ignored_non_object";
  }

  const normalizedThreadId = normalizeIncomingSlackThreadId(
    args.threadId,
    message,
  );
  const baseLogContext = getMessageLogContext({
    message: message as {
      author?: { userId?: string };
      raw?: Record<string, unknown>;
    },
    normalizedThreadId,
  });
  if ("threadId" in message) {
    (message as Record<string, unknown>).threadId = normalizedThreadId;
  }

  const typedMessage = message as {
    author?: { isMe?: boolean };
    id?: unknown;
    isMention?: boolean;
  };
  if (typedMessage.author?.isMe) {
    logIgnoredIngressResult({
      eventName: "queue_ingress_ignored_self_message",
      logContext: baseLogContext,
      messageId: nonEmptyString(typedMessage.id),
      routeResult: "ignored_self_message",
      body: "Ignoring self-authored message before queue routing",
    });
    return "ignored_self_message";
  }

  const messageId = nonEmptyString(typedMessage.id);
  if (!messageId) {
    logIgnoredIngressResult({
      eventName: "queue_ingress_ignored_missing_message_id",
      logContext: baseLogContext,
      routeResult: "ignored_missing_message_id",
      body: "Ignoring message without an id before queue routing",
    });
    return "ignored_missing_message_id";
  }

  const isSubscribed = await getStateAdapter().isSubscribed(normalizedThreadId);
  const mentionSource = typedMessage.isMention
    ? "sdk_flag"
    : runtime.detectMention?.(adapter, message)
      ? "fallback_detector"
      : undefined;
  const isMention = mentionSource !== undefined;
  if (isMention && !typedMessage.isMention) {
    typedMessage.isMention = true;
  }
  const isDirectMessage = isSlackDirectMessageThreadId(normalizedThreadId);
  const kind = determineThreadMessageKind({
    isDirectMessage,
    isSubscribed,
    isMention,
  });
  if (!kind) {
    logIgnoredIngressResult({
      eventName: "queue_ingress_ignored_unsubscribed_non_mention",
      logContext: baseLogContext,
      messageId,
      routeResult: "ignored_unsubscribed_non_mention",
      body: "Ignoring unsubscribed non-mention message before queue routing",
    });
    return "ignored_unsubscribed_non_mention";
  }

  const dedupKey = buildQueueIngressDedupKey(normalizedThreadId, messageId);
  const alreadyDeduped = await hasQueueIngressDedup(dedupKey);
  if (alreadyDeduped) {
    logInfo(
      "queue_ingress_dedup_hit",
      baseLogContext,
      {
        "messaging.message.id": messageId,
        "app.queue.message_kind": kind,
        "app.queue.dedup_key": dedupKey,
        "app.queue.dedup_outcome": "duplicate",
        ...(mentionSource ? { "app.slack.mention_source": mentionSource } : {}),
        "app.queue.route_result": "ignored_duplicate",
      },
      "Skipping duplicate incoming message before queue enqueue",
    );
    return "ignored_duplicate";
  }

  const thread = (await runtime.createThread(
    adapter,
    normalizedThreadId,
    message,
    isSubscribed,
  )) as Thread;
  const serializedMessage = serializeMessageForQueue(message as Message);
  const serializedThread = serializeThreadForQueue(thread);

  const payload: ThreadMessagePayload = {
    dedupKey,
    kind,
    message: serializedMessage,
    normalizedThreadId,
    thread: serializedThread,
  };

  await withContext(
    {
      slackThreadId: normalizedThreadId,
      slackChannelId: thread.channelId,
      slackUserId: (message as Message).author.userId,
    },
    async () => {
      let processingReactionAdded = false;
      let queueMessageId: string | undefined;
      try {
        await addReactionToMessage({
          channelId: thread.channelId,
          timestamp: messageId,
          emoji: "eyes",
        });
        processingReactionAdded = true;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logWarn(
          "queue_ingress_reaction_add_failed",
          {},
          {
            "messaging.message.id": messageId,
            "app.queue.message_kind": kind,
            ...(mentionSource
              ? { "app.slack.mention_source": mentionSource }
              : {}),
            "error.message": errorMessage,
          },
          "Failed to add ingress processing reaction",
        );
      }

      try {
        await withSpan(
          "queue.enqueue_message",
          "queue.enqueue_message",
          {
            slackThreadId: normalizedThreadId,
            slackChannelId: thread.channelId,
            slackUserId: (message as Message).author.userId,
          },
          async () => {
            queueMessageId = await enqueueQueueIngressMessage({
              dedupKey,
              enqueueThreadMessage: args.enqueueThreadMessage,
              payload,
            });
            if (queueMessageId) {
              setSpanAttributes({
                "app.queue.message_id": queueMessageId,
              });
            }
          },
          {
            "messaging.message.id": messageId,
            "app.queue.message_kind": kind,
          },
        );
      } catch (error) {
        if (processingReactionAdded) {
          try {
            await removeReactionFromMessage({
              channelId: thread.channelId,
              timestamp: messageId,
              emoji: "eyes",
            });
          } catch (cleanupError) {
            const cleanupErrorMessage =
              cleanupError instanceof Error
                ? cleanupError.message
                : String(cleanupError);
            logWarn(
              "queue_ingress_reaction_cleanup_failed",
              {},
              {
                "messaging.message.id": messageId,
                "app.queue.message_kind": kind,
                "error.message": cleanupErrorMessage,
              },
              "Failed to remove ingress processing reaction after enqueue failure",
            );
          }
        }
        throw error;
      }

      logInfo(
        "queue_ingress_enqueued",
        {},
        {
          "messaging.message.id": messageId,
          "app.queue.message_kind": kind,
          ...(mentionSource
            ? { "app.slack.mention_source": mentionSource }
            : {}),
          "app.queue.dedup_key": dedupKey,
          "app.queue.dedup_outcome": "primary",
          "app.queue.route_result": "routed",
          ...(queueMessageId ? { "app.queue.message_id": queueMessageId } : {}),
        },
        "Routing incoming message to queue",
      );

      const marked = await claimQueueIngressDedup(
        dedupKey,
        QUEUE_INGRESS_DEDUP_TTL_MS,
      );
      if (!marked) {
        logInfo(
          "queue_ingress_dedup_mark_failed",
          {},
          {
            "messaging.message.id": messageId,
            "app.queue.message_kind": kind,
            "app.queue.dedup_key": dedupKey,
          },
          "Queue ingress dedup state write failed after enqueue",
        );
      }
    },
  );

  return "routed";
}
