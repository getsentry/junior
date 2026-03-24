import type { Message, Thread } from "chat";
import type { SlackTurnRuntime } from "@/chat/runtime/slack-runtime";
import type { ThreadMessageKind } from "@/chat/queue/types";
import { downloadPrivateSlackFile as downloadPrivateSlackFileImpl } from "@/chat/slack/client";

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

function rehydrateAttachmentFetchers(
  message: ThreadMessageDispatchArgs["message"],
  downloadPrivateSlackFile: typeof downloadPrivateSlackFileImpl,
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
