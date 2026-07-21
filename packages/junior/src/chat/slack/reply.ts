import {
  buildSlackReplyBlocks,
  type SlackReplyFooter,
} from "@/chat/slack/footer";
import { postSlackMessage } from "@/chat/slack/outbound";
import { splitSlackReplyText } from "@/chat/slack/output";

export type PlannedSlackReplyStage =
  | "thread_reply"
  | "thread_reply_continuation";

export interface PlannedSlackReplyPost {
  stage: PlannedSlackReplyStage;
  text: string;
}

/** Plan the Slack posts for one completed assistant message. */
export function planSlackAssistantMessagePosts(
  text: string,
): PlannedSlackReplyPost[] {
  return splitSlackReplyText(text).map((chunk, index) => ({
    text: chunk,
    stage: index === 0 ? "thread_reply" : "thread_reply_continuation",
  }));
}

function findLastTextPostIndex(posts: PlannedSlackReplyPost[]): number {
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    if (posts[index]?.text.trim().length) {
      return index;
    }
  }

  return -1;
}

/**
 * Deliver planned Slack reply posts over raw Slack Web API calls for resume and
 * callback handlers that do not have a Chat SDK thread object.
 */
export async function postSlackApiReplyPosts(args: {
  beforePost?: () => Promise<void>;
  footer?: SlackReplyFooter;
  channelId: string;
  onPostError?: (context: {
    error: unknown;
    messageTs?: string;
    stage: PlannedSlackReplyStage;
  }) => Promise<void> | void;
  threadTs?: string;
  posts: PlannedSlackReplyPost[];
}): Promise<string | undefined> {
  const lastTextPostIndex = findLastTextPostIndex(args.posts);
  let lastPostedMessageTs: string | undefined;

  for (const [index, post] of args.posts.entries()) {
    const hasVisibleDelivery = post.text.trim().length > 0;
    if (hasVisibleDelivery) {
      await args.beforePost?.();
    }

    let messageTs: string | undefined;
    try {
      if (post.text.trim().length > 0) {
        const footer = index === lastTextPostIndex ? args.footer : undefined;
        const blocks = buildSlackReplyBlocks(post.text, footer);
        const response = await postSlackMessage({
          channelId: args.channelId,
          threadTs: args.threadTs,
          text: post.text,
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
        stage: post.stage,
      });
      throw error;
    }
  }

  return lastPostedMessageTs;
}
