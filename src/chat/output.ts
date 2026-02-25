import type { PostableMessage } from "chat";

const MAX_INLINE_CHARS = 2200;
const MAX_INLINE_LINES = 45;

export interface SlackOutputOptions {
  forceAttachment?: boolean;
  attachmentPrefix?: string;
  forceInline?: boolean;
}

interface ParsedDeliveryDirectives {
  text: string;
  options: SlackOutputOptions;
}

function normalizeForSlack(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function summarizeForInline(text: string): string {
  const lines = text.split("\n");
  const summaryLines: string[] = [];
  let charCount = 0;

  for (const line of lines) {
    if (summaryLines.length >= 12 || charCount + line.length + 1 > 900) {
      break;
    }
    summaryLines.push(line);
    charCount += line.length + 1;
  }

  return summaryLines.join("\n").trim();
}

function shouldAttach(text: string): boolean {
  if (text.length > MAX_INLINE_CHARS) {
    return true;
  }

  return text.split("\n").length > MAX_INLINE_LINES;
}

function sanitizePrefix(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || "junior-response";
}

function parseDeliveryDirectives(text: string): ParsedDeliveryDirectives {
  const match = text.match(/^\s*<delivery>\s*([\s\S]*?)\s*<\/delivery>\s*/i);
  if (!match) {
    return { text, options: {} };
  }

  const options: SlackOutputOptions = {};

  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.trim();
    const kv = line.match(/^-?\s*([a-z_]+)\s*:\s*(.+)$/i);
    if (!kv) {
      continue;
    }

    const key = kv[1].toLowerCase();
    const value = kv[2].trim().replace(/^["']|["']$/g, "");

    if (key === "mode") {
      if (value.toLowerCase() === "attachment") {
        options.forceAttachment = true;
      }
      if (value.toLowerCase() === "inline") {
        options.forceInline = true;
      }
    }

    if (key === "attachment_prefix") {
      options.attachmentPrefix = sanitizePrefix(value);
    }
  }

  return {
    text: text.slice(match[0].length),
    options
  };
}

export function buildSlackOutputMessage(text: string, options: SlackOutputOptions = {}): PostableMessage {
  const parsed = parseDeliveryDirectives(text);
  const mergedOptions: SlackOutputOptions = {
    ...parsed.options,
    ...options
  };
  const normalized = normalizeForSlack(parsed.text);

  if (!normalized) {
    return { markdown: "I couldn't produce a response." };
  }

  const shouldUploadFile = mergedOptions.forceInline ? false : mergedOptions.forceAttachment || shouldAttach(normalized);

  if (!shouldUploadFile) {
    return { markdown: normalized };
  }

  const inlineSummary = summarizeForInline(normalized) || "Response was longer than expected.";
  const attachmentPrefix = sanitizePrefix(mergedOptions.attachmentPrefix ?? "junior-response");
  const filename = `${attachmentPrefix}-${new Date().toISOString().replace(/[.:]/g, "-")}.md`;

  return {
    markdown: [
      "Summary:",
      inlineSummary,
      "",
      `_Full response attached as ${filename}._`
    ].join("\n"),
    files: [
      {
        data: Buffer.from(normalized, "utf8"),
        filename,
        mimeType: "text/markdown"
      }
    ]
  };
}

export const slackOutputPolicy = {
  maxInlineChars: MAX_INLINE_CHARS,
  maxInlineLines: MAX_INLINE_LINES
};
