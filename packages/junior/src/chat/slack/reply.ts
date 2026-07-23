/**
 * Slack reply delivery.
 *
 * Owns chunking, conversation footer attachment, and outbound posting for
 * destination-visible Slack replies. Runtime call sites should prefer
 * `sendSlackReply` instead of assembling footer/blocks themselves.
 */
import type { Thread } from "chat";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { postSlackMessage } from "@/chat/slack/outbound";
import {
  buildSlackOutputMessage,
  splitSlackReplyText,
} from "@/chat/slack/output";

type SendSlackReplyOptions = {
  beforePost?: () => Promise<void>;
  channelId: string;
  conversationId?: string;
  text: string;
  threadTs?: string;
};

/**
 * Send one destination-visible Slack reply.
 *
 * Chunks oversized text, builds the conversation footer from
 * `conversationId`, and posts through the shared Slack outbound boundary.
 */
export async function sendSlackReply(
  options: SendSlackReplyOptions,
): Promise<string | undefined> {
  const chunks = splitSlackReplyText(options.text);
  const footer = buildSlackReplyFooter({
    conversationId: options.conversationId,
  });
  let lastPostedMessageTs: string | undefined;

  for (const [index, text] of chunks.entries()) {
    await options.beforePost?.();
    const blocks = buildSlackReplyBlocks(
      text,
      index === chunks.length - 1 ? footer : undefined,
    );
    const response = await postSlackMessage({
      channelId: options.channelId,
      threadTs: options.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
    });
    lastPostedMessageTs = response.ts;
  }

  return lastPostedMessageTs;
}

/** Send a reply through the Chat SDK thread. */
export async function sendReplyToThread(options: {
  beforePost?: () => Promise<void>;
  text: string;
  thread: Thread;
}): Promise<string | undefined> {
  let lastPostedMessageTs: string | undefined;

  for (const text of splitSlackReplyText(options.text)) {
    await options.beforePost?.();
    const sentMessage = await options.thread.post(
      buildSlackOutputMessage(text),
    );
    lastPostedMessageTs = sentMessage.id;
  }

  return lastPostedMessageTs;
}
