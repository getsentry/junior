import {
  Chat,
  type ActionEvent,
  type Adapter,
  type AppHomeOpenedEvent,
  type AssistantContextChangedEvent,
  type AssistantThreadStartedEvent,
  type Message,
  type ModalCloseEvent,
  type ReactionEvent,
  type SlashCommandEvent,
  type WebhookOptions,
} from "chat";
import { normalizeIncomingSlackThreadId } from "@/chat/ingress/message-router";

type ChatInternals = {
  logger?: {
    error?: (message: string, data?: Record<string, unknown>) => void;
  };
  handleReactionEvent: (
    event: Omit<ReactionEvent, "adapter" | "thread"> & {
      adapter?: Adapter;
    },
  ) => Promise<void>;
  handleActionEvent: (
    event: Omit<ActionEvent, "thread" | "openModal"> & {
      adapter: Adapter;
    },
    options: WebhookOptions | undefined,
  ) => Promise<void>;
  retrieveModalContext: (
    adapterName: string,
    contextId: string,
  ) => Promise<{
    relatedThread: unknown;
    relatedMessage: unknown;
    relatedChannel: unknown;
  }>;
  handleSlashCommandEvent: (
    event: Omit<SlashCommandEvent, "channel" | "openModal"> & {
      adapter: Adapter;
      channelId: string;
    },
    options: WebhookOptions | undefined,
  ) => Promise<void>;
  modalCloseHandlers: Array<{
    callbackIds: string[];
    handler: (event: unknown) => Promise<void>;
  }>;
  assistantThreadStartedHandlers: Array<
    (event: AssistantThreadStartedEvent) => Promise<void>
  >;
  assistantContextChangedHandlers: Array<
    (event: AssistantContextChangedEvent) => Promise<void>
  >;
  appHomeOpenedHandlers: Array<(event: AppHomeOpenedEvent) => Promise<void>>;
};

function enqueueBackgroundTask(
  options: WebhookOptions | undefined,
  task: Promise<void>,
): void {
  if (!options?.waitUntil) {
    throw new Error("Chat background processing requires waitUntil");
  }
  options.waitUntil(task);
}

export class JuniorChat<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> extends Chat<TAdapters> {
  /**
   * Normalize Slack thread IDs before the SDK's concurrency queue.
   *
   * The SDK uses the `threadId` parameter as the lock/queue key
   * (Chat.handleIncomingMessage → getLockKey). @chat-adapter/slack
   * (as of 4.22.0) builds DM thread IDs as `slack:<channel>:` (empty
   * thread_ts) when the Slack event has no `thread_ts` field — it uses
   * `event.thread_ts || ""` instead of falling back to `event.ts`.
   * See @chat-adapter/slack/dist/index.js:1466.
   *
   * A DM root event arrives as `slack:D123:` while a reply in the same
   * thread carries `slack:D123:<ts>`, splitting the lock/state/subscription
   * keys and breaking conversation continuity.
   *
   * We fix this by resolving the message eagerly (even when the adapter
   * provides a factory), deriving the canonical thread ID from
   * `raw.channel` + `raw.thread_ts ?? raw.ts`, and passing both the
   * normalized threadId and concrete message to super.processMessage.
   *
   * Remove this override when @chat-adapter/slack uses `event.ts` as
   * the DM thread_ts fallback.
   */
  override processMessage(
    adapter: Adapter,
    threadId: string,
    messageOrFactory: Message | (() => Promise<Message>),
    options?: WebhookOptions,
  ): void {
    if (typeof messageOrFactory === "function") {
      // The SDK uses threadId as the lock key *before* resolving the
      // factory (Chat.processMessage:2207). We must resolve eagerly so
      // we can pass the normalized threadId to super. The SDK's own
      // processMessage wraps the work in waitUntil, so we do the same.
      const runtime = this as unknown as ChatInternals;
      enqueueBackgroundTask(
        options,
        (async (): Promise<void> => {
          try {
            const message = await messageOrFactory();
            const normalized = normalizeIncomingSlackThreadId(
              threadId,
              message,
            );
            if (normalized !== threadId && "threadId" in message) {
              (message as unknown as Record<string, unknown>).threadId =
                normalized;
            }
            super.processMessage(adapter, normalized, message, options);
          } catch (error) {
            runtime.logger?.error?.("Message factory resolution error", {
              error,
              threadId,
            });
          }
        })(),
      );
      return;
    }
    const normalized = normalizeIncomingSlackThreadId(
      threadId,
      messageOrFactory,
    );
    if (normalized !== threadId && "threadId" in messageOrFactory) {
      (messageOrFactory as unknown as Record<string, unknown>).threadId =
        normalized;
    }
    super.processMessage(adapter, normalized, messageOrFactory, options);
  }

  override processReaction(
    event: Omit<ReactionEvent, "adapter" | "thread"> & {
      adapter?: Adapter;
    },
    options?: WebhookOptions,
  ): void {
    const runtime = this as unknown as ChatInternals;

    enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          await runtime.handleReactionEvent(event);
        } catch (error) {
          runtime.logger?.error?.("Reaction processing error", {
            error,
            emoji: event.emoji,
            messageId: event.messageId,
          });
        }
      })(),
    );
  }

  override processAction(
    event: Omit<ActionEvent, "thread" | "openModal"> & {
      adapter: Adapter;
    },
    options: WebhookOptions | undefined,
  ): Promise<void> {
    const runtime = this as unknown as ChatInternals;

    const task = (async (): Promise<void> => {
      try {
        await runtime.handleActionEvent(event, options);
      } catch (error) {
        runtime.logger?.error?.("Action processing error", {
          error,
          actionId: event.actionId,
          messageId: event.messageId,
        });
      }
    })();
    enqueueBackgroundTask(options, task);
    return task;
  }

  override processModalClose(
    event: Omit<
      ModalCloseEvent,
      "relatedThread" | "relatedMessage" | "relatedChannel"
    >,
    contextId?: string,
    options?: WebhookOptions,
  ): void {
    const runtime = this as unknown as ChatInternals;

    enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          const { relatedThread, relatedMessage, relatedChannel } =
            await runtime.retrieveModalContext(
              event.adapter.name,
              contextId ?? "",
            );
          const fullEvent = {
            ...event,
            relatedThread,
            relatedMessage,
            relatedChannel,
          };
          for (const { callbackIds, handler } of runtime.modalCloseHandlers) {
            if (
              callbackIds.length === 0 ||
              callbackIds.includes(event.callbackId)
            ) {
              await handler(fullEvent);
            }
          }
        } catch (error) {
          runtime.logger?.error?.("Modal close handler error", {
            error,
            callbackId: event.callbackId,
          });
        }
      })(),
    );
  }

  override processSlashCommand(
    event: Omit<SlashCommandEvent, "channel" | "openModal"> & {
      adapter: Adapter;
      channelId: string;
    },
    options: WebhookOptions | undefined,
  ): void {
    const runtime = this as unknown as ChatInternals;

    enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          await runtime.handleSlashCommandEvent(event, options);
        } catch (error) {
          runtime.logger?.error?.("Slash command processing error", {
            error,
            command: event.command,
            text: event.text,
          });
        }
      })(),
    );
  }

  override processAssistantThreadStarted(
    event: AssistantThreadStartedEvent,
    options?: WebhookOptions,
  ): void {
    const runtime = this as unknown as ChatInternals;

    enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          for (const handler of runtime.assistantThreadStartedHandlers) {
            await handler(event);
          }
        } catch (error) {
          runtime.logger?.error?.("Assistant thread started handler error", {
            error,
            threadId: event.threadId,
          });
        }
      })(),
    );
  }

  override processAssistantContextChanged(
    event: AssistantContextChangedEvent,
    options?: WebhookOptions,
  ): void {
    const runtime = this as unknown as ChatInternals;

    enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          for (const handler of runtime.assistantContextChangedHandlers) {
            await handler(event);
          }
        } catch (error) {
          runtime.logger?.error?.("Assistant context changed handler error", {
            error,
            threadId: event.threadId,
          });
        }
      })(),
    );
  }

  override processAppHomeOpened(
    event: AppHomeOpenedEvent,
    options?: WebhookOptions,
  ): void {
    const runtime = this as unknown as ChatInternals;

    enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          for (const handler of runtime.appHomeOpenedHandlers) {
            await handler(event);
          }
        } catch (error) {
          runtime.logger?.error?.("App home opened handler error", {
            error,
            userId: event.userId,
          });
        }
      })(),
    );
  }
}
