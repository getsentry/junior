import type { FileUpload, PostableMessage } from "chat";
import { logWarn } from "@/chat/observability";

const MAX_INLINE_CHARS = 2200;
const MAX_INLINE_LINES = 45;

export interface SlackOutputOptions {
  files?: FileUpload[];
}

function normalizeForSlack(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function buildSlackOutputMessage(text: string, options: SlackOutputOptions = {}): PostableMessage {
  const normalized = normalizeForSlack(text);

  if (!normalized) {
    logWarn("slack_output_normalized_empty", {}, {
      "app.output.original_length": text.length,
      "app.output.parsed_length": normalized.length,
      "app.output.file_count": options.files?.length ?? 0
    }, "Slack output normalized to empty content");
    return {
      markdown: "I couldn't produce a response.",
      files: options.files
    };
  }

  return {
    markdown: normalized,
    files: options.files
  };
}

export const slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
  maxInlineLines: MAX_INLINE_LINES
};
