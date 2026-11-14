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
  type WebhookOptions,
} from "chat";
import {
  normalizeIncomingSlackThreadId,
  withNormalizedThreadId,
} from "@/chat/ingress/message-router";
import { isSlackWorkspaceMember } from "@/chat/ingress/workspace-membership";
import { logException } from "@/chat/logging";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
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
): Promise<void> {
  if (!options?.waitUntil) {
    throw new Error("Chat background processing requires waitUntil");
  }
  options.waitUntil(task);
  return task;
}

export class JuniorChat<
  TAdapters extends Record<string, Adapter> = Record<string, Adapter>,
> extends Chat<TAdapters> {
  /**
   * Normalize Slack thread IDs before the SDK's concurrency queue.
   *
   * Slack DM roots can arrive with an empty thread timestamp, while
   * later replies include the root timestamp. Resolve factories before
   * delegating so the lock/state/subscription key is canonicalized before
   * the SDK computes its per-thread queue key.
   */
  override processMessage(
    adapter: Adapter,
    threadId: string,
    messageOrFactory: Message | (() => Promise<Message>),
    options?: WebhookOptions,
  ): Promise<void> {
    if (typeof messageOrFactory === "function") {
      return enqueueBackgroundTask(
        options,
        runWithTurnRequestDeadline(async (): Promise<void> => {
          let message: Message;
          try {
            message = await messageOrFactory();
          } catch (error) {
            // best-effort: owning boundary. This Chat SDK task runs in waitUntil
            // after the webhook ack, so no caller can receive the error.
            logException(error, "chat.message_factory.failed", {
              "messaging.message.conversation_id": threadId,
            });
            return;
          }
          if (!(await isSlackWorkspaceMember(message.raw, this.getState()))) {
            return;
          }
          const normalized = normalizeIncomingSlackThreadId(threadId, message);
          await super.processMessage(
            adapter,
            normalized,
            withNormalizedThreadId(message, normalized),
            options,
          );
        }),
      );
    }

    const message = messageOrFactory;
    return runWithTurnRequestDeadline(async () => {
      if (!(await isSlackWorkspaceMember(message.raw, this.getState()))) return;
      const normalized = normalizeIncomingSlackThreadId(threadId, message);
      await super.processMessage(
        adapter,
        normalized,
        withNormalizedThreadId(message, normalized),
        options,
      );
    });
  }

  override processReaction(
    event: Omit<ReactionEvent, "adapter" | "thread"> & {
      adapter?: Adapter;
    },
    options?: WebhookOptions,
  ): void {
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const runtime = this as ChatInternals;

    void enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          await runtime.handleReactionEvent(event);
        } catch (error) {
          // best-effort: owning boundary. This Chat SDK task runs in waitUntil
          // after the webhook ack, so no caller can receive the error.
          logException(error, "chat.reaction.failed", {
            "messaging.message.id": event.messageId,
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
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const runtime = this as ChatInternals;

    const task = (async (): Promise<void> => {
      try {
        await runtime.handleActionEvent(event, options);
      } catch (error) {
        // best-effort: owning boundary. This Chat SDK task runs in waitUntil
        // after the webhook ack, so no caller can receive the error.
        logException(error, "chat.action.failed", {
          "messaging.message.id": event.messageId,
        });
      }
    })();
    void enqueueBackgroundTask(options, task);
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
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const runtime = this as ChatInternals;

    void enqueueBackgroundTask(
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
          // best-effort: owning boundary. This Chat SDK task runs in waitUntil
          // after the webhook ack, so no caller can receive the error.
          logException(error, "chat.modal_close.failed");
        }
      })(),
    );
  }

  override processAssistantThreadStarted(
    event: AssistantThreadStartedEvent,
    options?: WebhookOptions,
  ): void {
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const runtime = this as ChatInternals;

    void enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          for (const handler of runtime.assistantThreadStartedHandlers) {
            await handler(event);
          }
        } catch (error) {
          // best-effort: owning boundary. This Chat SDK task runs in waitUntil
          // after the webhook ack, so no caller can receive the error.
          logException(error, "chat.assistant_thread_started.failed", {
            "messaging.message.conversation_id": event.threadId,
          });
        }
      })(),
    );
  }

  override processAssistantContextChanged(
    event: AssistantContextChangedEvent,
    options?: WebhookOptions,
  ): void {
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const runtime = this as ChatInternals;

    void enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          for (const handler of runtime.assistantContextChangedHandlers) {
            await handler(event);
          }
        } catch (error) {
          // best-effort: owning boundary. This Chat SDK task runs in waitUntil
          // after the webhook ack, so no caller can receive the error.
          logException(error, "chat.assistant_context_changed.failed", {
            "messaging.message.conversation_id": event.threadId,
          });
        }
      })(),
    );
  }

  override processAppHomeOpened(
    event: AppHomeOpenedEvent,
    options?: WebhookOptions,
  ): void {
    // @ts-expect-error non-overlapping boundary cast; rule forbids as-unknown-as chains
    const runtime = this as ChatInternals;

    void enqueueBackgroundTask(
      options,
      (async (): Promise<void> => {
        try {
          for (const handler of runtime.appHomeOpenedHandlers) {
            await handler(event);
          }
        } catch (error) {
          // best-effort: owning boundary. This Chat SDK task runs in waitUntil
          // after the webhook ack, so no caller can receive the error.
          logException(error, "chat.app_home_opened.failed");
        }
      })(),
    );
  }
}
