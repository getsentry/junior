import { Chat } from "chat";
import type { Message, Thread } from "chat";
import type { ThreadMessageKind, ThreadMessagePayload } from "@/chat/workflow/types";
import { claimWorkflowIngressDedup, getStateAdapter } from "@/chat/state";
import { logInfo, setSpanAttributes, withContext, withSpan } from "@/chat/observability";

type WebhookOptions = {
  waitUntil?: (task: Promise<unknown>) => void;
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
export const WORKFLOW_INGRESS_DEDUP_TTL_MS = 5 * 60 * 1000;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function serializeMessageForWorkflow(message: Message): ThreadMessagePayload["message"] {
  const candidate = message as Message & { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") {
    return candidate.toJSON() as ThreadMessagePayload["message"];
  }

  return {
    _type: "chat:Message",
    ...(message as unknown as Record<string, unknown>)
  } as ThreadMessagePayload["message"];
}

function serializeThreadForWorkflow(thread: Thread): ThreadMessagePayload["thread"] {
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

export function buildWorkflowIngressDedupKey(normalizedThreadId: string, messageId: string): string {
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

interface WorkflowRoutingRuntime {
  createThread: ChatLike["createThread"];
  detectMention?: ChatLike["detectMention"];
}

interface WorkflowRoutingDeps {
  claimDedup: (key: string, ttlMs: number) => Promise<boolean>;
  getIsSubscribed: (threadId: string) => Promise<boolean>;
  logInfo: typeof logInfo;
  routeToThreadWorkflow: (normalizedThreadId: string, payload: ThreadMessagePayload) => Promise<string | undefined>;
}

const defaultWorkflowRoutingDeps: WorkflowRoutingDeps = {
  claimDedup: (key, ttlMs) => claimWorkflowIngressDedup(key, ttlMs),
  getIsSubscribed: (threadId) => getStateAdapter().isSubscribed(threadId),
  logInfo,
  routeToThreadWorkflow: async (normalizedThreadId, payload) => {
    const { routeToThreadWorkflow } = await import("@/chat/workflow/router");
    return await routeToThreadWorkflow(normalizedThreadId, payload);
  }
};

export type WorkflowIngressRouteResult =
  | "ignored_non_object"
  | "ignored_self_message"
  | "ignored_missing_message_id"
  | "ignored_unsubscribed_non_mention"
  | "ignored_duplicate"
  | "routed";

export async function routeIncomingMessageToWorkflow(args: {
  adapter: unknown;
  message: unknown;
  runtime: WorkflowRoutingRuntime;
  threadId: string;
  deps?: WorkflowRoutingDeps;
}): Promise<WorkflowIngressRouteResult> {
  const deps = args.deps ?? defaultWorkflowRoutingDeps;
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

  const dedupKey = buildWorkflowIngressDedupKey(normalizedThreadId, messageId);
  const claimed = await deps.claimDedup(dedupKey, WORKFLOW_INGRESS_DEDUP_TTL_MS);
  if (!claimed) {
    deps.logInfo(
      "workflow_ingress_dedup_hit",
      {
        slackThreadId: normalizedThreadId,
        slackUserId: (message as Message).author.userId
      },
      {
        "messaging.message.id": messageId,
        "app.workflow.message_kind": kind
      },
      "Skipping duplicate incoming message before workflow routing"
    );
    return "ignored_duplicate";
  }

  const thread = (await runtime.createThread(adapter, normalizedThreadId, message, isSubscribed)) as Thread;
  const serializedMessage = serializeMessageForWorkflow(message as Message);
  const serializedThread = serializeThreadForWorkflow(thread);
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
      let routedRunId: string | undefined;
      await withSpan(
        "workflow.route_message",
        "workflow.route_message",
        {
          slackThreadId: normalizedThreadId,
          slackChannelId: thread.channelId,
          slackUserId: (message as Message).author.userId,
          workflowRunId: routedRunId
        },
        async () => {
          routedRunId = await deps.routeToThreadWorkflow(normalizedThreadId, payload);
          if (routedRunId) {
            setSpanAttributes({
              "app.workflow.run_id": routedRunId
            });
          }
        },
        {
          "messaging.message.id": messageId,
          "app.workflow.message_kind": kind
        }
      );

      deps.logInfo(
        "workflow_ingress_enqueued",
        {},
        {
          "messaging.message.id": messageId,
          "app.workflow.message_kind": kind,
          ...(routedRunId ? { "app.workflow.run_id": routedRunId } : {})
        },
        "Routing incoming message to thread workflow"
      );
    }
  );

  return "routed";
}

function scheduleBackgroundWork(
  options: WebhookOptions | undefined,
  run: () => Promise<void>,
  onUnhandledError?: (error: unknown) => void
): void {
  const task = run();
  if (options?.waitUntil) {
    options.waitUntil(task);
    return;
  }

  // Some invocations may not provide waitUntil (non-webhook/test contexts).
  // In that case we still surface failures instead of letting promise rejections
  // disappear without structured logging.
  void task.catch((error) => {
    onUnhandledError?.(error);
  });
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
        const result = await routeIncomingMessageToWorkflow({
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
        throw err;
      }
    };

    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Message processing error", { error, threadId });
    });
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

    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Reaction processing error", {
        error,
        emoji: event.emoji,
        messageId: event.messageId
      });
    });
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

    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Action processing error", {
        error,
        actionId: event.actionId,
        messageId: event.messageId
      });
    });
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

    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Modal close handler error", {
        error,
        callbackId: event.callbackId
      });
    });
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

    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("Slash command processing error", {
        error,
        command: event.command,
        text: event.text
      });
    });
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

      scheduleBackgroundWork(options, run, (error) => {
        this.logger?.error?.("Assistant thread started handler error", {
          error,
          threadId: event.threadId
        });
      });
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

      scheduleBackgroundWork(options, run, (error) => {
        this.logger?.error?.("Assistant context changed handler error", {
          error,
          threadId: event.threadId
        });
      });
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

    scheduleBackgroundWork(options, run, (error) => {
      this.logger?.error?.("App home opened handler error", {
        error,
        userId: event.userId
      });
    });
  };
}

installChatBackgroundPatch();
