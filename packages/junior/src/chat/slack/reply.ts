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

/** Inputs shared by Slack reply delivery implementations. */
export interface SendSlackReplyArgs {
  beforePost?: () => Promise<void>;
  channelId: string;
  conversationId?: string;
  text: string;
  threadTs?: string;
}

/** Deliver one completed assistant reply for an active Chat SDK thread. */
export type SlackAssistantReplyDelivery = (
  args: SendSlackReplyArgs & { thread: Thread },
) => Promise<string | undefined>;

/**
 * Send one destination-visible Slack reply.
 *
 * Chunks oversized text, builds the conversation footer from
 * `conversationId`, and posts through the shared Slack outbound boundary.
 */
export async function sendSlackReply(
  args: SendSlackReplyArgs,
): Promise<string | undefined> {
  const chunks = splitSlackReplyText(args.text);
  const footer = buildSlackReplyFooter({
    conversationId: args.conversationId,
  });
  let lastPostedMessageTs: string | undefined;

  for (const [index, text] of chunks.entries()) {
    await args.beforePost?.();
    const blocks = buildSlackReplyBlocks(
      text,
      index === chunks.length - 1 ? footer : undefined,
    );
    const response = await postSlackMessage({
      channelId: args.channelId,
      threadTs: args.threadTs,
      text,
      ...(blocks ? { blocks } : {}),
    });
    lastPostedMessageTs = response.ts;
  }

  return lastPostedMessageTs;
}

/** Deliver an assistant reply through the Chat SDK thread boundary. */
export const postSlackAssistantReplyToThread: SlackAssistantReplyDelivery =
  async (args) => {
    let lastPostedMessageTs: string | undefined;

    for (const text of splitSlackReplyText(args.text)) {
      await args.beforePost?.();
      const sentMessage = await args.thread.post(buildSlackOutputMessage(text));
      lastPostedMessageTs = sentMessage.id;
    }

    return lastPostedMessageTs;
  };
