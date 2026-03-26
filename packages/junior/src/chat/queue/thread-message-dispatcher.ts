import type { Message, Thread } from "chat";
import type { SlackTurnRuntime } from "@/chat/runtime/slack-runtime";
import { downloadPrivateSlackFile as downloadPrivateSlackFileImpl } from "@/chat/slack/client";

export type ThreadMessageKind = "new_mention" | "subscribed_message";

export interface ThreadMessageDispatchArgs {
  beforeFirstResponsePost?: () => Promise<void>;
  kind: ThreadMessageKind;
  message: Message;
  thread: Thread;
}

export type ThreadMessageRuntime = Pick<
  SlackTurnRuntime<unknown>,
  "handleNewMention" | "handleSubscribedMessage"
>;

export type ThreadMessageDispatcher = (
  args: ThreadMessageDispatchArgs,
) => Promise<void>;

export interface CreateThreadMessageDispatcherOptions {
  downloadPrivateSlackFile?: typeof downloadPrivateSlackFileImpl;
  runtime: ThreadMessageRuntime;
}

/**
 * Attach Slack private-file download functions to deserialized attachments.
 *
 * The Chat SDK's `concurrency: "queue"` strategy serializes queued messages
 * via `Message.toJSON()`, which strips `fetchData` (a function) and `data`
 * (a Buffer). When dequeued, attachments have a `url` but no fetcher.
 * This re-attaches a bot-token-auth'd download callback.
 *
 * No-ops when `fetchData` is already present, so safe to call unconditionally.
 */
export function rehydrateAttachmentFetchers(
  message: { attachments: Array<{ fetchData?: unknown; url?: string }> },
  downloadPrivateSlackFile: typeof downloadPrivateSlackFileImpl = downloadPrivateSlackFileImpl,
): void {
  for (const attachment of message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () =>
        downloadPrivateSlackFile(attachment.url as string);
    }
  }
}

export function createThreadMessageDispatcher(
  options: CreateThreadMessageDispatcherOptions,
): ThreadMessageDispatcher {
  const downloadPrivateSlackFile =
    options.downloadPrivateSlackFile ?? downloadPrivateSlackFileImpl;

  return async function dispatch(
    args: ThreadMessageDispatchArgs,
  ): Promise<void> {
    rehydrateAttachmentFetchers(args.message, downloadPrivateSlackFile);

    if (args.kind === "new_mention") {
      await options.runtime.handleNewMention(args.thread, args.message, {
        beforeFirstResponsePost: args.beforeFirstResponsePost,
      });
      return;
    }

    await options.runtime.handleSubscribedMessage(args.thread, args.message, {
      beforeFirstResponsePost: args.beforeFirstResponsePost,
    });
  };
}
