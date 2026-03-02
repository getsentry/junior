import type { FileUpload, PostableMessage } from "chat";
import { logWarn } from "@/chat/observability";

const MAX_INLINE_CHARS = 2200;
const MAX_INLINE_LINES = 45;

export interface SlackOutputOptions {
  files?: FileUpload[];
}

export function ensureBlockSpacing(text: string): string {
  const codeBlockPattern = /^```/;
  const listItemPattern = /^[-*•]\s|^\d+\.\s/;
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isCodeFence = codeBlockPattern.test(line.trimStart());

    if (isCodeFence) {
      // Insert blank line before code fence if needed (only outside code blocks)
      if (!inCodeBlock) {
        const prev = result.length > 0 ? result[result.length - 1] : undefined;
        if (prev !== undefined && prev.trim() !== "") {
          result.push("");
        }
      }
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }

    if (inCodeBlock) {
      result.push(line);
      continue;
    }

    const prev = result.length > 0 ? result[result.length - 1] : undefined;

    // Insert blank line if: prev is non-empty, current is non-empty,
    // prev is not already a blank line, and they're not both list items
    if (
      prev !== undefined &&
      prev.trim() !== "" &&
      line.trim() !== "" &&
      !(listItemPattern.test(prev.trimStart()) && listItemPattern.test(line.trimStart()))
    ) {
      result.push("");
    }

    result.push(line);
  }

  return result.join("\n");
}

function normalizeForSlack(text: string): string {
  let normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "");
  normalized = ensureBlockSpacing(normalized);
  return normalized
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
