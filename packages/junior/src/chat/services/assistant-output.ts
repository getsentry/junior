import type { AssistantMessage } from "@earendil-works/pi-ai";
import { containsNoReplyMarker, isNoReplyMarker } from "@/chat/no-reply";
import { extractAssistantText } from "@/chat/pi/transcript";

const THINKING_XML_BLOCK_PATTERN =
  /[ \t]*<thinking\b[^>]*>[\s\S]*?<\/thinking>[ \t]*(?:\r?\n)?/gi;
const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

/** Stable reason recorded when assistant output cannot be delivered. */
export type AssistantOutputRejection =
  | "empty"
  | "execution_escape"
  | "raw_tool_payload";

export type AssistantOutput =
  | { kind: "deliver"; text: string }
  | { kind: "reject"; reason: AssistantOutputRejection }
  | { kind: "suppress" };

function isExecutionEscape(text: string): boolean {
  return (
    /\b(want me to proceed|do you want me to proceed|shall i proceed|can i proceed|should i proceed|let me do that now|give me a moment|tag me again|fresh invocation)\b/i.test(
      text,
    ) ||
    /\b(i (don't|do not) have access to (active )?tool|tool results came back empty|prior results .* empty|cannot access .*tool|need to (run|load) .*tool .* first)\b/i.test(
      text,
    )
  );
}

function parseJson(text: string): unknown {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return JSON.parse(fenced?.[1] ?? text) as unknown;
  } catch {
    return undefined;
  }
}

function isToolPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const type =
    typeof payload.type === "string" ? payload.type.toLowerCase() : "";
  if (
    type.startsWith("tool-") ||
    ["tool_use", "tool_call", "tool_result", "tool_error"].includes(type)
  ) {
    return true;
  }
  const hasName =
    typeof payload.toolName === "string" || typeof payload.name === "string";
  return hasName && ("input" in payload || "args" in payload);
}

function isRawToolPayload(text: string): boolean {
  const parsed = parseJson(text);
  return Array.isArray(parsed)
    ? parsed.some((value) => isToolPayload(value))
    : isToolPayload(parsed);
}

/** Remove provider reasoning wrappers while preserving fenced code examples. */
export function sanitizeAssistantText(text: string): string {
  let result = "";
  let cursor = 0;
  for (const match of text.matchAll(FENCED_CODE_BLOCK_PATTERN)) {
    const start = match.index;
    if (start === undefined) continue;
    result += text.slice(cursor, start).replace(THINKING_XML_BLOCK_PATTERN, "");
    result += match[0];
    cursor = start + match[0].length;
  }
  return (
    result + text.slice(cursor).replace(THINKING_XML_BLOCK_PATTERN, "")
  ).trim();
}

/** Decide whether one completed assistant message may be delivered. */
export function classifyAssistantOutput(
  message: AssistantMessage,
): AssistantOutput {
  if (message.content.some((part) => part.type === "toolCall")) {
    return { kind: "suppress" };
  }

  const text = sanitizeAssistantText(extractAssistantText(message));
  if (!text) return { kind: "reject", reason: "empty" };
  if (isNoReplyMarker(text) || containsNoReplyMarker(text)) {
    return { kind: "suppress" };
  }
  if (isRawToolPayload(text)) {
    return { kind: "reject", reason: "raw_tool_payload" };
  }
  if (isExecutionEscape(text)) {
    return { kind: "reject", reason: "execution_escape" };
  }
  return { kind: "deliver", text };
}
