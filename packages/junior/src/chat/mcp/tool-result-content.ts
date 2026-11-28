/**
 * How an MCP tool result becomes the content that the agent sees: the
 * summary of structured content, and the bound on its size.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { PluginMcpToolCallResult } from "./client";
import {
  estimateTextTokens,
  textCharsForTokens,
} from "@/chat/services/token-estimate";

const MAX_TOOL_RESULT_TOKENS = 10_000;
const MAX_TOOL_RESULT_BYTES = 32 * 1024;

/** The structured content of a result as indented JSON, when it has any. */
export function summarizeStructuredContent(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return JSON.stringify(value, null, 2);
}

function summarizeResourcePart(part: {
  type: "resource";
  resource:
    | { uri: string; text: string; mimeType?: string | undefined }
    | { uri: string; blob: string; mimeType?: string | undefined };
}): string {
  if ("text" in part.resource) {
    return part.resource.text;
  }

  return [
    `Resource: ${part.resource.uri}`,
    ...(part.resource.mimeType ? [`Mime Type: ${part.resource.mimeType}`] : []),
    `Blob bytes (base64): ${part.resource.blob.length}`,
  ].join("\n");
}

/** The text and image parts of an MCP result, as agent tool content. */
export function toAgentToolContent(
  result: PluginMcpToolCallResult,
): Array<TextContent | ImageContent> {
  if ("toolResult" in result) {
    return [
      {
        type: "text",
        text: JSON.stringify(result.toolResult, null, 2),
      },
    ];
  }

  const content: Array<TextContent | ImageContent> = [];

  for (const part of result.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "image") {
      content.push({
        type: "image",
        data: part.data,
        mimeType: part.mimeType,
      });
      continue;
    }
    if (part.type === "audio") {
      content.push({
        type: "text",
        text: `Audio output (${part.mimeType}, ${part.data.length} base64 chars)`,
      });
      continue;
    }
    if (part.type === "resource_link") {
      content.push({
        type: "text",
        text: part.uri,
      });
      continue;
    }
    content.push({
      type: "text",
      text: summarizeResourcePart(part),
    });
  }

  if (content.length > 0) {
    return content;
  }

  const structured = summarizeStructuredContent(result.structuredContent);
  if (structured) {
    return [{ type: "text", text: structured }];
  }

  return [{ type: "text", text: "ok" }];
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function prefixWithin(
  value: string,
  maxChars: number,
  maxBytes: number,
): string {
  let low = 0;
  let high = Math.min(value.length, maxChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) {
    low -= 1;
  }
  return value.slice(0, low);
}

function suffixWithin(
  value: string,
  maxChars: number,
  maxBytes: number,
): string {
  let low = Math.max(0, value.length - maxChars);
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (utf8Bytes(value.slice(middle)) <= maxBytes) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  if (low < value.length && /[\uDC00-\uDFFF]/.test(value[low]!)) {
    low += 1;
  }
  return value.slice(low);
}

/** Cut the text of a result to the token and byte limits. Keep its images. */
export function boundMcpContent(
  content: Array<TextContent | ImageContent>,
): Array<TextContent | ImageContent> {
  const text = content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n\n");
  const originalBytes = utf8Bytes(text);
  const originalTokens = estimateTextTokens(text);
  if (
    originalTokens <= MAX_TOOL_RESULT_TOKENS &&
    originalBytes <= MAX_TOOL_RESULT_BYTES
  ) {
    return content;
  }

  const warning = `\n\nWarning: truncated output (original token count: ${originalTokens}; original bytes: ${originalBytes})\n\n`;
  const remainingChars =
    textCharsForTokens(MAX_TOOL_RESULT_TOKENS) - warning.length;
  const remainingBytes = MAX_TOOL_RESULT_BYTES - utf8Bytes(warning);
  const head = prefixWithin(
    text,
    Math.ceil(remainingChars / 2),
    Math.ceil(remainingBytes / 2),
  );
  const tail = suffixWithin(
    text.slice(head.length),
    remainingChars - head.length,
    remainingBytes - utf8Bytes(head),
  );

  return [
    { type: "text", text: `${head}${warning}${tail}` },
    ...content.filter((part): part is ImageContent => part.type === "image"),
  ];
}

// Keep the full text. The tool pipeline cuts long model-facing results and
// saves the full text to a file, so the text is not lost here.
/**
 * What the model sees of a result: its images, else its structured content,
 * else its text.
 */
export function toModelVisibleMcpContent(
  result: PluginMcpToolCallResult,
): Array<TextContent | ImageContent> {
  const content = toAgentToolContent(result);
  if (content.some((part) => part.type === "image")) {
    return content;
  }

  const structured = summarizeStructuredContent(result.structuredContent);
  if (structured) {
    return [{ type: "text", text: structured }];
  }

  return content;
}
