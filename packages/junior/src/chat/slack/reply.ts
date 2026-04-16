import { Buffer } from "node:buffer";
import type { FileUpload, PostableMessage } from "chat";
import type { AssistantReply } from "@/chat/respond";
import { resolveReplyDelivery } from "@/chat/services/reply-delivery-plan";
import { uploadFilesToThread } from "@/chat/slack/outbound";
import {
  buildSlackOutputMessage,
  splitSlackReplyText,
} from "@/chat/slack/output";

export type PlannedSlackReplyStage =
  | "thread_reply"
  | "thread_reply_continuation"
  | "thread_reply_files_followup";

export interface PlannedSlackReplyPost {
  message: PostableMessage;
  stage: PlannedSlackReplyStage;
}

function isInterruptedVisibleReply(reply: AssistantReply): boolean {
  return reply.diagnostics.outcome === "provider_error";
}

function buildChunkMessage(
  chunk: string,
  files?: FileUpload[],
): PostableMessage {
  return {
    markdown: chunk,
    ...(files ? { files } : {}),
  };
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
    message: buildChunkMessage(
      chunk,
      index === 0 ? args.firstFiles : undefined,
    ),
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

async function uploadReplyFilesBestEffort(args: {
  channelId: string;
  threadTs: string;
  files: FileUpload[];
}): Promise<void> {
  try {
    await uploadFilesToThread({
      channelId: args.channelId,
      threadTs: args.threadTs,
      files: await normalizeFileUploads(args.files),
    });
  } catch {
    // File followups should not turn a delivered resume reply into a failed turn.
  }
}

function getReplyMessageText(message: PostableMessage): string | undefined {
  if (typeof message !== "object" || message === null) {
    return undefined;
  }

  if ("markdown" in message && typeof message.markdown === "string") {
    return message.markdown;
  }

  if ("raw" in message && typeof message.raw === "string") {
    return message.raw;
  }

  return undefined;
}

function getReplyMessageFiles(
  message: PostableMessage,
): FileUpload[] | undefined {
  if (
    typeof message === "object" &&
    message !== null &&
    "files" in message &&
    Array.isArray(message.files)
  ) {
    return message.files;
  }

  return undefined;
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
  const { shouldPostThreadReply, attachFiles } = resolveReplyDelivery({
    reply: args.reply,
  });
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
      message: buildSlackOutputMessage("", replyFiles),
      stage: "thread_reply",
    });
  } else if (shouldPostThreadReply && textPosts.length === 0) {
    posts.push({
      message: buildSlackOutputMessage(args.reply.text),
      stage: "thread_reply",
    });
  }

  if (attachFiles === "followup" && replyFiles) {
    posts.push({
      message: buildSlackOutputMessage("", replyFiles),
      stage: "thread_reply_files_followup",
    });
  }

  return posts;
}

/**
 * Deliver planned Slack reply posts over raw Slack Web API calls for resume and
 * callback handlers that do not have a Chat SDK thread object.
 */
export async function postSlackApiReplyPosts(args: {
  channelId: string;
  threadTs: string;
  posts: PlannedSlackReplyPost[];
  postMessage: (
    channelId: string,
    threadTs: string,
    text: string,
  ) => Promise<void>;
}): Promise<void> {
  for (const post of args.posts) {
    const text = getReplyMessageText(post.message);
    if (text && text.trim().length > 0) {
      await args.postMessage(args.channelId, args.threadTs, text);
    }

    const files = getReplyMessageFiles(post.message);
    if (!files?.length) {
      continue;
    }

    await uploadReplyFilesBestEffort({
      channelId: args.channelId,
      threadTs: args.threadTs,
      files,
    });
  }
}
