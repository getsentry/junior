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
  type SlackReplyFooter,
} from "@/chat/slack/footer";
import { postSlackMessage } from "@/chat/slack/outbound";
import {
  buildSlackOutputMessage,
  splitSlackReplyText,
} from "@/chat/slack/output";

export type SlackReplyChunkStage = "thread_reply" | "thread_reply_continuation";

interface SlackReplyChunk {
  stage: SlackReplyChunkStage;
  text: string;
}

export interface SendSlackReplyErrorContext {
  error: unknown;
  messageTs?: string;
  stage: SlackReplyChunkStage;
}

/** Inputs shared by Slack reply delivery implementations. */
export interface SendSlackReplyArgs {
  beforePost?: () => Promise<void>;
  channelId: string;
  conversationId?: string;
  onPostError?: (context: SendSlackReplyErrorContext) => Promise<void> | void;
  text: string;
  threadTs?: string;
}

/** Deliver one completed assistant reply for an active Chat SDK thread. */
export type SlackAssistantReplyDelivery = (
  args: SendSlackReplyArgs & { thread: Thread },
) => Promise<string | undefined>;

/** Split one reply into Slack-sized chunks with continuation stages. */
function planSlackReplyChunks(text: string): SlackReplyChunk[] {
  return splitSlackReplyText(text).map((chunk, index) => ({
    text: chunk,
    stage: index === 0 ? "thread_reply" : "thread_reply_continuation",
  }));
}

function findLastTextChunkIndex(chunks: SlackReplyChunk[]): number {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    if (chunks[index]?.text.trim().length) {
      return index;
    }
  }

  return -1;
}

/**
 * Post pre-planned Slack reply chunks, attaching the footer on the last
 * visible chunk only.
 */
async function postSlackReplyChunks(args: {
  beforePost?: () => Promise<void>;
  channelId: string;
  chunks: SlackReplyChunk[];
  footer?: SlackReplyFooter;
  onPostError?: (context: SendSlackReplyErrorContext) => Promise<void> | void;
  threadTs?: string;
}): Promise<string | undefined> {
  const lastTextChunkIndex = findLastTextChunkIndex(args.chunks);
  let lastPostedMessageTs: string | undefined;

  for (const [index, chunk] of args.chunks.entries()) {
    const hasVisibleDelivery = chunk.text.trim().length > 0;
    if (hasVisibleDelivery) {
      await args.beforePost?.();
    }

    let messageTs: string | undefined;
    try {
      if (chunk.text.trim().length > 0) {
        const footer = index === lastTextChunkIndex ? args.footer : undefined;
        const blocks = buildSlackReplyBlocks(chunk.text, footer);
        const response = await postSlackMessage({
          channelId: args.channelId,
          threadTs: args.threadTs,
          text: chunk.text,
          ...(blocks ? { blocks } : {}),
        });
        messageTs = response.ts;
        lastPostedMessageTs = response.ts;
      }

      continue;
    } catch (error) {
      await args.onPostError?.({
        error,
        messageTs,
        stage: chunk.stage,
      });
      throw error;
    }
  }

  return lastPostedMessageTs;
}

/**
 * Send one destination-visible Slack reply.
 *
 * Chunks oversized text, builds the conversation footer from
 * `conversationId`, and posts through the shared Slack outbound boundary.
 */
export async function sendSlackReply(
  args: SendSlackReplyArgs,
): Promise<string | undefined> {
  const chunks = planSlackReplyChunks(args.text);
  if (chunks.length === 0) {
    return undefined;
  }

  return await postSlackReplyChunks({
    beforePost: args.beforePost,
    channelId: args.channelId,
    chunks,
    footer: buildSlackReplyFooter({
      conversationId: args.conversationId,
    }),
    onPostError: args.onPostError,
    threadTs: args.threadTs,
  });
}

/** Deliver an assistant reply through the Chat SDK thread boundary. */
export const postSlackAssistantReplyToThread: SlackAssistantReplyDelivery =
  async (args) => {
    const chunks = planSlackReplyChunks(args.text);
    let lastPostedMessageTs: string | undefined;

    for (const chunk of chunks) {
      await args.beforePost?.();
      try {
        const sentMessage = await args.thread.post(
          buildSlackOutputMessage(chunk.text),
        );
        lastPostedMessageTs = sentMessage.id;
      } catch (error) {
        await args.onPostError?.({ error, stage: chunk.stage });
        throw error;
      }
    }

    return lastPostedMessageTs;
  };
