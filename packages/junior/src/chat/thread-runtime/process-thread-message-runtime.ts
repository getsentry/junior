import type { Message, Thread } from "chat";
import type { ThreadMessageKind } from "@/chat/queue/types";
import { downloadPrivateSlackFile } from "@/chat/slack-actions/client";

function rehydrateAttachmentFetchers(
  payload: { message: { attachments: Array<{ fetchData?: () => Promise<Buffer>; url?: string }> } }
): void {
  for (const attachment of payload.message.attachments) {
    if (!attachment.fetchData && attachment.url) {
      attachment.fetchData = () => downloadPrivateSlackFile(attachment.url as string);
    }
  }
}

export async function processThreadMessageRuntime(args: {
  kind: ThreadMessageKind;
  message: Message;
  thread: Thread;
}): Promise<void> {
  const { appSlackRuntime } = await import("@/chat/bot");
  const runtimePayload = {
    message: args.message,
    thread: args.thread
  };
  rehydrateAttachmentFetchers(runtimePayload);

  if (args.kind === "new_mention") {
    await appSlackRuntime.handleNewMention(args.thread, args.message);
    return;
  }

  await appSlackRuntime.handleSubscribedMessage(args.thread, args.message);
}
