/**
 * Slack posts, files, canvases, and reactions read back from captured API calls.
 */
import { type CapturedSlackApiCall } from "@junior-tests/msw/captured-slack-api-calls";
import {
  type EvalResult,
  type EvalAttachedFile,
  type EvalAssistantPost,
} from "./types";

/** Return the first non-empty string in a value or array of values. */
export function toFirstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const resolved = toFirstString(entry);
      if (resolved) return resolved;
    }
  }
  return undefined;
}

function buildReactionKey(input: {
  channel: string;
  emoji: string;
  timestamp: string;
}): string {
  return `${input.channel}:${input.timestamp}:${input.emoji}`;
}

function toEvalFiles(value: unknown): EvalAttachedFile[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const files = (value as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  return files.map((file) => {
    if (!file || typeof file !== "object") {
      return {
        filename: "file",
        isImage: false,
      };
    }
    const filename =
      (typeof (file as { filename?: unknown }).filename === "string"
        ? (file as { filename: string }).filename
        : undefined) ??
      (typeof (file as { name?: unknown }).name === "string"
        ? (file as { name: string }).name
        : undefined) ??
      "file";
    const mediaType =
      (typeof (file as { mimeType?: unknown }).mimeType === "string"
        ? (file as { mimeType: string }).mimeType
        : undefined) ??
      (typeof (file as { mediaType?: unknown }).mediaType === "string"
        ? (file as { mediaType: string }).mediaType
        : undefined);
    const data =
      (file as { data?: unknown }).data instanceof Buffer
        ? (file as { data: Buffer }).data
        : undefined;
    return {
      filename,
      isImage: Boolean(mediaType?.startsWith("image/")),
      ...(mediaType ? { mimeType: mediaType } : {}),
      ...(data ? { sizeBytes: data.byteLength } : {}),
    };
  });
}

function isImageFilename(filename: string): boolean {
  const normalized = filename.toLowerCase();
  return (
    normalized.endsWith(".png") ||
    normalized.endsWith(".jpg") ||
    normalized.endsWith(".jpeg") ||
    normalized.endsWith(".gif") ||
    normalized.endsWith(".webp")
  );
}

function toEvalUploadedFiles(files: unknown): EvalAttachedFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  return files.map((file) => {
    const fields = file as {
      filename?: unknown;
      mimeType?: unknown;
      mimetype?: unknown;
      name?: unknown;
      title?: unknown;
    };
    const filename =
      toFirstString(fields.title) ??
      toFirstString(fields.filename) ??
      toFirstString(fields.name) ??
      "file";
    const mediaType =
      toFirstString(fields.mimeType) ?? toFirstString(fields.mimetype);
    return {
      filename,
      isImage: Boolean(
        mediaType?.startsWith("image/") || isImageFilename(filename),
      ),
      ...(mediaType ? { mimeType: mediaType } : {}),
    };
  });
}

/** Read canvases, posts, file uploads, and reactions from captured Slack API calls. */
export function collectSlackArtifactsFromCapturedCalls(
  calls: CapturedSlackApiCall[],
): Pick<EvalResult, "canvases" | "channelPosts" | "reactions"> & {
  filePosts: EvalAssistantPost[];
} {
  const canvases: EvalResult["canvases"] = [];
  const channelPosts: EvalResult["channelPosts"] = [];
  const filePosts: EvalAssistantPost[] = [];
  const reactions = new Map<string, EvalResult["reactions"][number]>();

  for (const call of calls) {
    if (call.method === "canvases.create") {
      const title = toFirstString(call.params.title) ?? "";
      const documentContent =
        call.params.document_content &&
        typeof call.params.document_content === "object"
          ? (call.params.document_content as Record<string, unknown>)
          : undefined;
      const markdown = documentContent
        ? (toFirstString(documentContent.markdown) ?? "")
        : "";
      if (!title && markdown.length === 0) {
        continue;
      }
      canvases.push({
        title,
        markdown,
      });
      continue;
    }

    if (call.method === "chat.postMessage") {
      const channel = toFirstString(call.params.channel);
      const text = toFirstString(call.params.text);
      if (!channel || text === undefined) {
        continue;
      }
      const threadTs = toFirstString(call.params.thread_ts);
      channelPosts.push({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      continue;
    }

    if (call.method === "files.completeUploadExternal") {
      const channel = toFirstString(call.params.channel_id);
      const files = toEvalUploadedFiles(call.params.files);
      if (!channel || files.length === 0) {
        continue;
      }
      const threadTs = toFirstString(call.params.thread_ts);
      filePosts.push({
        channel,
        eventType: threadTs ? "thread_post" : "channel_post",
        files,
        text: toFirstString(call.params.initial_comment) ?? "",
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      continue;
    }

    if (call.method === "reactions.add") {
      const channel = toFirstString(call.params.channel);
      const emoji = toFirstString(call.params.name);
      const timestamp = toFirstString(call.params.timestamp);
      if (!channel || !emoji || !timestamp) {
        continue;
      }
      const reaction = {
        channel,
        emoji,
        timestamp,
      };
      reactions.set(buildReactionKey(reaction), reaction);
      continue;
    }

    if (call.method === "reactions.remove") {
      const channel = toFirstString(call.params.channel);
      const emoji = toFirstString(call.params.name);
      const timestamp = toFirstString(call.params.timestamp);
      if (!channel || !emoji || !timestamp) {
        continue;
      }
      reactions.delete(
        buildReactionKey({
          channel,
          emoji,
          timestamp,
        }),
      );
    }
  }

  return {
    canvases,
    channelPosts,
    filePosts,
    reactions: [...reactions.values()],
  };
}

/** Normalize a harness thread post into text plus attached files. */
export function toEvalAssistantPost(value: unknown): EvalAssistantPost {
  if (typeof value === "string") {
    return {
      text: value,
      files: [],
    };
  }
  if (value && typeof value === "object") {
    const markdown = (value as { markdown?: unknown }).markdown;
    const files = toEvalFiles(value);
    if (typeof markdown === "string") {
      return { text: markdown, files };
    }
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "string") {
      return { text: raw, files };
    }
    return { text: "", files };
  }
  return {
    text: String(value),
    files: [],
  };
}
