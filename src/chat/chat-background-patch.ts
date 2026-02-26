import { Chat } from "chat";

type LegacyWebhookOptions = {
  waitUntil?: (task: Promise<unknown>) => void;
};

type BackgroundWebhookOptions = LegacyWebhookOptions & {
  runInBackground?: (run: () => Promise<unknown>) => void;
};

type ChatLike = {
  logger?: {
    error?: (message: string, data?: Record<string, unknown>) => void;
  };
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

const PATCH_FLAG = Symbol.for("junior.chat.runInBackgroundPatch");

function scheduleBackgroundWork(
  instance: ChatLike,
  options: BackgroundWebhookOptions | undefined,
  run: () => Promise<void>
): void {
  if (options?.runInBackground) {
    options.runInBackground(run);
    return;
  }

  const task = run();
  if (options?.waitUntil) {
    options.waitUntil(task);
  }
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
    options?: BackgroundWebhookOptions
  ): void {
    const run = async (): Promise<void> => {
      try {
        const message =
          typeof messageOrFactory === "function"
            ? await (messageOrFactory as () => Promise<unknown>)()
            : messageOrFactory;
        await this.handleIncomingMessage(adapter, threadId, message);
      } catch (err) {
        this.logger?.error?.("Message processing error", { error: err, threadId });
      }
    };

    scheduleBackgroundWork(this, options, run);
  };

  (chatProto as unknown as { processReaction: unknown }).processReaction = function processReaction(
    this: ChatLike,
    event: { emoji?: string; messageId?: string },
    options?: BackgroundWebhookOptions
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

    scheduleBackgroundWork(this, options, run);
  };

  (chatProto as unknown as { processAction: unknown }).processAction = function processAction(
    this: ChatLike,
    event: { actionId?: string; messageId?: string },
    options?: BackgroundWebhookOptions
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

    scheduleBackgroundWork(this, options, run);
  };

  (chatProto as unknown as { processModalClose: unknown }).processModalClose = function processModalClose(
    this: ChatLike,
    event: { adapter: { name: string }; callbackId: string },
    contextId: string,
    options?: BackgroundWebhookOptions
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

    scheduleBackgroundWork(this, options, run);
  };

  (chatProto as unknown as { processSlashCommand: unknown }).processSlashCommand = function processSlashCommand(
    this: ChatLike,
    event: { command?: string; text?: string },
    options?: BackgroundWebhookOptions
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

    scheduleBackgroundWork(this, options, run);
  };

  (chatProto as unknown as { processAssistantThreadStarted: unknown }).processAssistantThreadStarted =
    function processAssistantThreadStarted(
      this: ChatLike,
      event: { threadId?: string },
      options?: BackgroundWebhookOptions
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

      scheduleBackgroundWork(this, options, run);
    };

  (chatProto as unknown as { processAssistantContextChanged: unknown }).processAssistantContextChanged =
    function processAssistantContextChanged(
      this: ChatLike,
      event: { threadId?: string },
      options?: BackgroundWebhookOptions
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

      scheduleBackgroundWork(this, options, run);
    };

  (chatProto as unknown as { processAppHomeOpened: unknown }).processAppHomeOpened = function processAppHomeOpened(
    this: ChatLike,
    event: { userId?: string },
    options?: BackgroundWebhookOptions
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

    scheduleBackgroundWork(this, options, run);
  };
}

installChatBackgroundPatch();
