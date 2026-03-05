import { Chat } from "chat";
import type { Message, Thread } from "chat";
import type { ThreadMessageKind, ThreadMessagePayload } from "@/chat/queue/types";
import { claimQueueIngressDedup, getStateAdapter, hasQueueIngressDedup } from "@/chat/state";
import { logInfo, logWarn, setSpanAttributes, withContext, withSpan } from "@/chat/observability";

type WebhookOptions = {
  waitUntil?: (task: () => Promise<unknown>) => void;
};

type ChatLike = {
  logger?: {
    error?: (message: string, data?: Record<string, unknown>) => void;
  };
  createThread: (
    adapter: unknown,
    threadId: string,
    initialMessage: unknown,
    isSubscribedContext?: boolean
  ) => Promise<unknown>;
  detectMention?: (adapter: unknown, message: unknown) => boolean;
  handleIncomingMessage: (adapter: unknown, threadId: string, message: unknown) => Promise<void>;
  handleReactionEvent: (event: unknown) => Promise<void>;
  handleActionEvent: (event: unknown) => Promise<void>;
  retrieveModalContext: (adapterName: string, contextId: string) => Promise<{
    relatedThread: unknown;
    relatedMessage: unknown;
    relatedChannel: unknown;
  }>;
  handleSlashCommandEvent: (event: unknown) => Promise<void>;
  modalCloseHandlers: Array<{ callbackIds: string[]; handler: (event: unknown) => Promise<void> }>;
  assistantThreadStartedHandlers: Array<(event: unknown) => Promise<void>>;
  assistantContextChangedHandlers: Array<(event: unknown) => Promise<void>>;
  appHomeOpenedHandlers: Array<(event: unknown) => Promise<void>>;
};

const PATCH_FLAG = Symbol.for("junior.chat.backgroundPatch");
// Keep ingress dedupe keys long enough to cover delayed Slack retries.
export const QUEUE_INGRESS_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function serializeMessageForQueue(message: Message): ThreadMessagePayload["message"] {
  const candidate = message as Message & { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON() as ThreadMessagePayload["message"];
  }

  return {
    _type: "chat:Message",
    ...(message as unknown as Record<string, unknown>)
  } as ThreadMessagePayload["message"];
}

function serializeThreadForQueue(thread: Thread): ThreadMessagePayload["thread"] {
  const candidate = thread as Thread & { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON() as ThreadMessagePayload["thread"];
  }

  return {
    _type: "chat:Thread",
    ...(thread as unknown as Record<string, unknown>)
  } as ThreadMessagePayload["thread"];
}

// Derive canonical Slack thread IDs from the raw event payload (channel + thread_ts/ts)
// rather than trusting adapter-provided thread ID parts which may be incomplete.
export function normalizeIncomingSlackThreadId(threadId: string, message: unknown): string {
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

export function buildQueueIngressDedupKey(normalizedThreadId: string, messageId: string): string {
  return `${normalizedThreadId}:${messageId}`;
}

export function determineThreadMessageKind(args: {
  isMention: boolean;
  isSubscribed: boolean;
}): ThreadMessageKind | undefined {
  if (args.isSubscribed) {
    return "subscribed_message";
  }

  if (args.isMention) {
    return "new_mention";
  }

  return undefined;
}

interface QueueRoutingRuntime {
  createThread: ChatLike["createThread"];
  detectMention?: ChatLike["detectMention"];
}

interface QueueRoutingDeps {
  hasDedup: (key: string) => Promise<boolean>;
  markDedup: (key: string, ttlMs: number) => Promise<boolean>;
  getIsSubscribed: (threadId: string) => Promise<boolean>;
  logInfo: typeof logInfo;
  logWarn: typeof logWarn;
  enqueueThreadMessage: (payload: ThreadMessagePayload, dedupKey: string) => Promise<string | undefined>;
  addProcessingReaction: (input: { channelId: string; timestamp: string }) => Promise<void>;
  removeProcessingReaction: (input: { channelId: string; timestamp: string }) => Promise<void>;
}

const defaultQueueRoutingDeps: QueueRoutingDeps = {
  hasDedup: (key) => hasQueueIngressDedup(key),
  markDedup: (key, ttlMs) => claimQueueIngressDedup(key, ttlMs),
  getIsSubscribed: (threadId) => getStateAdapter().isSubscribed(threadId),
  logInfo,
  logWarn,
  enqueueThreadMessage: async (payload, dedupKey) => {
    const { enqueueThreadMessage } = await import("@/chat/queue/client");
    return await enqueueThreadMessage(payload, {
      idempotencyKey: dedupKey
    });
  },
  addProcessingReaction: async ({ channelId, timestamp }) => {
    const { addReactionToMessage } = await import("@/chat/slack-actions/channel");
    await addReactionToMessage({
      channelId,
      timestamp,
      emoji: "eyes"
    });
  },
  removeProcessingReaction: async ({ channelId, timestamp }) => {
    const { removeReactionFromMessage } = await import("@/chat/slack-actions/channel");
    await removeReactionFromMessage({
      channelId,
      timestamp,
      emoji: "eyes"
    });
  }
};

export type QueueIngressRouteResult =
  | "ignored_non_object"
  | "ignored_self_message"
  | "ignored_missing_message_id"
  | "ignored_unsubscribed_non_mention"
  | "ignored_duplicate"
  | "routed";

export async function routeIncomingMessageToQueue(args: {
  adapter: unknown;
  message: unknown;
  runtime: QueueRoutingRuntime;
  threadId: string;
  deps?: QueueRoutingDeps;
}): Promise<QueueIngressRouteResult> {
  const deps = args.deps ?? defaultQueueRoutingDeps;
  const { adapter, runtime } = args;
  const message = args.message;
  if (!message || typeof message !== "object") {
    return "ignored_non_object";
  }

  const normalizedThreadId = normalizeIncomingSlackThreadId(args.threadId, message);
  if ("threadId" in message) {
    (message as Record<string, unknown>).threadId = normalizedThreadId;
  }

  const typedMessage = message as {
    author?: { isMe?: boolean };
    id?: unknown;
    isMention?: boolean;
  };
  if (typedMessage.author?.isMe) {
    return "ignored_self_message";
  }

  const messageId = nonEmptyString(typedMessage.id);
  if (!messageId) {
    return "ignored_missing_message_id";
  }

  const isSubscribed = await deps.getIsSubscribed(normalizedThreadId);
  const isMention = Boolean(typedMessage.isMention || runtime.detectMention?.(adapter, message));
  const kind = determineThreadMessageKind({
    isSubscribed,
    isMention
  });
  if (!kind) {
    return "ignored_unsubscribed_non_mention";
  }

  const dedupKey = buildQueueIngressDedupKey(normalizedThreadId, messageId);
  const alreadyDeduped = await deps.hasDedup(dedupKey);
  if (alreadyDeduped) {
    deps.logInfo(
      "queue_ingress_dedup_hit",
      {
        slackThreadId: normalizedThreadId,
        slackUserId: (message as Message).author.userId
      },
      {
        "messaging.message.id": messageId,
        "app.queue.message_kind": kind,
        "app.queue.dedup_key": dedupKey,
        "app.queue.dedup_outcome": "duplicate"
      },
      "Skipping duplicate incoming message before queue enqueue"
    );
    return "ignored_duplicate";
  }

  const thread = (await runtime.createThread(adapter, normalizedThreadId, message, isSubscribed)) as Thread;
  const serializedMessage = serializeMessageForQueue(message as Message);
  const serializedThread = serializeThreadForQueue(thread);
  const payload: ThreadMessagePayload = {
    dedupKey,
    kind,
    message: serializedMessage,
    normalizedThreadId,
    thread: serializedThread
  };

  await withContext(
    {
      slackThreadId: normalizedThreadId,
      slackChannelId: thread.channelId,
      slackUserId: (message as Message).author.userId
    },
    async () => {
      let processingReactionAdded = false;
      let queueMessageId: string | undefined;
      try {
        await deps.addProcessingReaction({
          channelId: thread.channelId,
          timestamp: messageId
        });
        processingReactionAdded = true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        deps.logWarn(
          "queue_ingress_reaction_add_failed",
          {},
          {
            "messaging.message.id": messageId,
            "app.queue.message_kind": kind,
            "error.message": errorMessage
          },
          "Failed to add ingress processing reaction"
        );
      }

      try {
        await withSpan(
          "queue.enqueue_message",
          "queue.enqueue_message",
          {
            slackThreadId: normalizedThreadId,
            slackChannelId: thread.channelId,
            slackUserId: (message as Message).author.userId
          },
          async () => {
            queueMessageId = await deps.enqueueThreadMessage(payload, dedupKey);
            if (queueMessageId) {
              setSpanAttributes({
                "app.queue.message_id": queueMessageId
              });
            }
          },
          {
            "messaging.message.id": messageId,
            "app.queue.message_kind": kind
          }
        );
      } catch (error) {
        if (processingReactionAdded) {
          try {
            await deps.removeProcessingReaction({
              channelId: thread.channelId,
              timestamp: messageId
            });
          } catch (cleanupError) {
            const cleanupErrorMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            deps.logWarn(
              "queue_ingress_reaction_cleanup_failed",
              {},
              {
                "messaging.message.id": messageId,
                "app.queue.message_kind": kind,
                "error.message": cleanupErrorMessage
              },
              "Failed to remove ingress processing reaction after enqueue failure"
            );
          }
        }
        throw error;
      }

      deps.logInfo(
        "queue_ingress_enqueued",
        {},
        {
          "messaging.message.id": messageId,
          "app.queue.message_kind": kind,
          "app.queue.dedup_key": dedupKey,
          "app.queue.dedup_outcome": "primary",
          ...(queueMessageId ? { "app.queue.message_id": queueMessageId } : {})
        },
        "Routing incoming message to queue"
      );

      const marked = await deps.markDedup(dedupKey, QUEUE_INGRESS_DEDUP_TTL_MS);
      if (!marked) {
        deps.logInfo(
          "queue_ingress_dedup_mark_failed",
          {},
          {
            "messaging.message.id": messageId,
            "app.queue.message_kind": kind,
            "app.queue.dedup_key": dedupKey
          },
          "Queue ingress dedup state write failed after enqueue"
        );
      }
    }
  );

  return "routed";
}

function scheduleBackgroundWork(options: WebhookOptions | undefined, run: () => Promise<void>): void {
  if (!options?.waitUntil) {
    throw new Error("Chat background processing requires waitUntil");
  }
  options.waitUntil(run);
  return;
}

export function installChatBackgroundPatch(): void {
  const target = Chat.prototype as unknown as Record<string | symbol, unknown>;
  if (target[PATCH_FLAG]) {
    return;
  }

  target[PATCH_FLAG] = true;
  const chatProto = Chat.prototype as unknown as ChatLike;

  (chatProto as unknown as { processMessage: unknown }).processMessage = function processMessage(
    this: ChatLike,
    adapter: unknown,
    threadId: string,
    messageOrFactory: unknown,
    options?: WebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        const message =
          typeof messageOrFactory === "function"
            ? await (messageOrFactory as () => Promise<unknown>)()
            : messageOrFactory;
        const result = await routeIncomingMessageToQueue({
          adapter,
          threadId,
          message,
          runtime: {
            createThread: this.createThread.bind(this),
            detectMention: this.detectMention?.bind(this)
          }
        });
        if (result === "ignored_missing_message_id") {
          const normalizedThreadId = normalizeIncomingSlackThreadId(threadId, message);
          this.logger?.error?.("Message processing error", {
            threadId: normalizedThreadId,
            reason: "missing_message_id"
          });
        }
      } catch (err) {
        this.logger?.error?.("Message processing error", { error: err, threadId });
      }
    };

    // processMessage already logs and rethrows inside run(); avoid duplicate
    // logging in non-waitUntil paths by not adding a second unhandled callback.
    scheduleBackgroundWork(options, run);
  };

  (chatProto as unknown as { processReaction: unknown }).processReaction = function processReaction(
    this: ChatLike,
    event: { emoji?: string; messageId?: string },
    options?: WebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        await this.handleReactionEvent(event);
      } catch (err) {
        this.logger?.error?.("Reaction processing error", {
          error: err,
          emoji: event.emoji,
          messageId: event.messageId
        });
      }
    };

    scheduleBackgroundWork(options, run);
  };

  (chatProto as unknown as { processAction: unknown }).processAction = function processAction(
    this: ChatLike,
    event: { actionId?: string; messageId?: string },
    options?: WebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        await this.handleActionEvent(event);
      } catch (err) {
        this.logger?.error?.("Action processing error", {
          error: err,
          actionId: event.actionId,
          messageId: event.messageId
        });
      }
    };

    scheduleBackgroundWork(options, run);
  };

  (chatProto as unknown as { processModalClose: unknown }).processModalClose = function processModalClose(
    this: ChatLike,
    event: { adapter: { name: string }; callbackId: string },
    contextId: string,
    options?: WebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        const { relatedThread, relatedMessage, relatedChannel } = await this.retrieveModalContext(event.adapter.name, contextId);
        const fullEvent = { ...event, relatedThread, relatedMessage, relatedChannel };
        for (const { callbackIds, handler } of this.modalCloseHandlers) {
          if (callbackIds.length === 0 || callbackIds.includes(event.callbackId)) {
            await handler(fullEvent);
          }
        }
      } catch (err) {
        this.logger?.error?.("Modal close handler error", {
          error: err,
          callbackId: event.callbackId
        });
      }
    };

    scheduleBackgroundWork(options, run);
  };

  (chatProto as unknown as { processSlashCommand: unknown }).processSlashCommand = function processSlashCommand(
    this: ChatLike,
    event: { command?: string; text?: string },
    options?: WebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        await this.handleSlashCommandEvent(event);
      } catch (err) {
        this.logger?.error?.("Slash command processing error", {
          error: err,
          command: event.command,
          text: event.text
        });
      }
    };

    scheduleBackgroundWork(options, run);
  };

  (chatProto as unknown as { processAssistantThreadStarted: unknown }).processAssistantThreadStarted =
    function processAssistantThreadStarted(
      this: ChatLike,
      event: { threadId?: string },
      options?: WebhookOptions
    ): void {
      const run = async (): Promise<void> => {
        try {
          for (const handler of this.assistantThreadStartedHandlers) {
            await handler(event);
          }
        } catch (err) {
          this.logger?.error?.("Assistant thread started handler error", {
            error: err,
            threadId: event.threadId
          });
        }
      };

      scheduleBackgroundWork(options, run);
    };

  (chatProto as unknown as { processAssistantContextChanged: unknown }).processAssistantContextChanged =
    function processAssistantContextChanged(
      this: ChatLike,
      event: { threadId?: string },
      options?: WebhookOptions
    ): void {
      const run = async (): Promise<void> => {
        try {
          for (const handler of this.assistantContextChangedHandlers) {
            await handler(event);
          }
        } catch (err) {
          this.logger?.error?.("Assistant context changed handler error", {
            error: err,
            threadId: event.threadId
          });
        }
      };

      scheduleBackgroundWork(options, run);
    };

  (chatProto as unknown as { processAppHomeOpened: unknown }).processAppHomeOpened = function processAppHomeOpened(
    this: ChatLike,
    event: { userId?: string },
    options?: WebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        for (const handler of this.appHomeOpenedHandlers) {
          await handler(event);
        }
      } catch (err) {
        this.logger?.error?.("App home opened handler error", {
          error: err,
          userId: event.userId
        });
      }
    };

    scheduleBackgroundWork(options, run);
  };
}

installChatBackgroundPatch();
