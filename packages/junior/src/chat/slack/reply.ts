import { Buffer } from "node:buffer";
import type { FileUpload } from "chat";
import type { AssistantReply } from "@/chat/respond";
import type { ReplyFileDelivery } from "@/chat/services/reply-delivery-plan";
import {
  buildSlackReplyBlocks,
  type SlackReplyFooter,
} from "@/chat/slack/footer";
import { postSlackMessage, uploadFilesToThread } from "@/chat/slack/outbound";
import {
  buildSlackOutputMessage,
  splitSlackReplyText,
} from "@/chat/slack/output";

export type PlannedSlackReplyStage =
  | "thread_reply"
  | "thread_reply_continuation"
  | "thread_reply_files_followup";

export interface PlannedSlackReplyPost {
  files?: FileUpload[];
  stage: PlannedSlackReplyStage;
  text: string;
}

function isInterruptedVisibleReply(reply: AssistantReply): boolean {
  return reply.diagnostics.outcome === "provider_error";
}

function resolveReplyDelivery(reply: AssistantReply): {
  shouldPostThreadReply: boolean;
  attachFiles: ReplyFileDelivery;
} {
  const replyHasFiles = Boolean(reply.files && reply.files.length > 0);
  const deliveryPlan = reply.deliveryPlan ?? {
    mode: reply.deliveryMode ?? "thread",
    postThreadText: (reply.deliveryMode ?? "thread") !== "channel_only",
    attachFiles: replyHasFiles ? "inline" : "none",
  };

  return {
    shouldPostThreadReply: deliveryPlan.postThreadText,
    attachFiles:
      replyHasFiles && deliveryPlan.attachFiles !== "none" ? "inline" : "none",
  };
}

function buildReplyText(text: string): string {
  const message = buildSlackOutputMessage(text);
  if (
    typeof message === "object" &&
    message !== null &&
    "markdown" in message &&
    typeof message.markdown === "string"
  ) {
    return message.markdown;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    "raw" in message &&
    typeof message.raw === "string"
  ) {
    return message.raw;
  }
  return "";
}

function buildTextPosts(args: {
  text: string;
  interrupted: boolean;
  firstFiles?: FileUpload[];
  firstStage?: PlannedSlackReplyStage;
}): PlannedSlackReplyPost[] {
  const chunks = splitSlackReplyText(args.text, {
    interrupted: args.interrupted,
  });
  return chunks.map((chunk, index) => ({
    text: chunk,
    ...(index === 0 && args.firstFiles ? { files: args.firstFiles } : {}),
    stage:
      index === 0
        ? (args.firstStage ?? "thread_reply")
        : "thread_reply_continuation",
  }));
}

async function normalizeFileUploads(
  files: FileUpload[],
): Promise<Array<{ data: Buffer; filename: string }>> {
  return await Promise.all(
    files.map(async (file) => {
      let data: Buffer;
      if (Buffer.isBuffer(file.data)) {
        data = file.data;
      } else if (file.data instanceof ArrayBuffer) {
        data = Buffer.from(file.data);
      } else {
        data = Buffer.from(await file.data.arrayBuffer());
      }
      return {
        data,
        filename: file.filename,
      };
    }),
  );
}

function findLastTextPostIndex(posts: PlannedSlackReplyPost[]): number {
  for (let index = posts.length - 1; index >= 0; index -= 1) {
    if (posts[index]?.text.trim().length) {
      return index;
    }
  }

  return -1;
}

async function uploadReplyFiles(args: {
  channelId: string;
  failureMode: "best_effort" | "strict";
  threadTs: string;
  files: FileUpload[];
}): Promise<void> {
  try {
    await uploadFilesToThread({
      channelId: args.channelId,
      threadTs: args.threadTs,
      files: await normalizeFileUploads(args.files),
    });
  } catch (error) {
    if (args.failureMode === "strict") {
      throw error;
    }

    // File followups should not turn a delivered resume reply into a failed turn.
  }
}

/**
 * Plan the Slack thread posts needed to realize a completed assistant reply,
 * including chunking, interruption markers, and file delivery.
 */
export function planSlackReplyPosts(args: {
  reply: AssistantReply;
}): PlannedSlackReplyPost[] {
  const replyFiles =
    args.reply.files && args.reply.files.length > 0
      ? args.reply.files
      : undefined;
  const { shouldPostThreadReply, attachFiles } = resolveReplyDelivery(
    args.reply,
  );
  const interrupted = isInterruptedVisibleReply(args.reply);

  const posts: PlannedSlackReplyPost[] = [];

  const textPosts = shouldPostThreadReply
    ? buildTextPosts({
        text: args.reply.text,
        interrupted,
        firstFiles: attachFiles === "inline" ? replyFiles : undefined,
      })
    : [];
  posts.push(...textPosts);

  if (attachFiles === "inline" && replyFiles && textPosts.length === 0) {
    posts.push({
      files: replyFiles,
      stage: "thread_reply",
      text: "",
    });
  } else if (shouldPostThreadReply && textPosts.length === 0) {
    posts.push({
      text: buildReplyText(args.reply.text),
      stage: "thread_reply",
    });
  }

  if (attachFiles === "followup" && replyFiles) {
    posts.push({
      files: replyFiles,
      stage: "thread_reply_files_followup",
      text: "",
    });
  }

  return posts;
}

/**
 * Deliver planned Slack reply posts over raw Slack Web API calls for resume and
 * callback handlers that do not have a Chat SDK thread object.
 */
export async function postSlackApiReplyPosts(args: {
  beforePost?: () => Promise<void>;
  footer?: SlackReplyFooter;
  channelId: string;
  fileUploadFailureMode?: "best_effort" | "strict";
  onPostError?: (context: {
    error: unknown;
    messageTs?: string;
    stage: PlannedSlackReplyStage;
  }) => Promise<void> | void;
  threadTs: string;
  posts: PlannedSlackReplyPost[];
}): Promise<string | undefined> {
  const lastTextPostIndex = findLastTextPostIndex(args.posts);
  let lastPostedMessageTs: string | undefined;

  for (const [index, post] of args.posts.entries()) {
    const hasVisibleDelivery =
      post.text.trim().length > 0 || post.files?.length;
    if (hasVisibleDelivery) {
      await args.beforePost?.();
    }

    let messageTs: string | undefined;
    try {
      if (post.text.trim().length > 0) {
        const response = await postSlackMessage({
          channelId: args.channelId,
          threadTs: args.threadTs,
          text: post.text,
          ...(index === lastTextPostIndex && args.footer
            ? { blocks: buildSlackReplyBlocks(post.text, args.footer) }
            : {}),
        });
        messageTs = response.ts;
        lastPostedMessageTs = response.ts;
      }

      if (!post.files?.length) {
        continue;
      }

      await uploadReplyFiles({
        channelId: args.channelId,
        failureMode: args.fileUploadFailureMode ?? "best_effort",
        threadTs: args.threadTs,
        files: post.files,
      });
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
