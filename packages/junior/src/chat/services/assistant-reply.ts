import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isNoReplyMarker, stripQuietMarker } from "@/chat/no-reply";
import { extractAssistantText } from "@/chat/pi/transcript";

const THINKING_XML_BLOCK_PATTERN =
  /[ \t]*<thinking\b[^>]*>[\s\S]*?<\/thinking>[ \t]*(?:\r?\n)?/gi;
const FENCED_CODE_BLOCK_PATTERN = /```[\s\S]*?```/g;

type ReplyDecision =
  | { kind: "deliver"; text: string; quiet?: true }
  | { kind: "empty" }
  | { kind: "suppress" };

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

/** Decide whether one completed assistant message becomes a reply. */
export function decideReply(message: AssistantMessage): ReplyDecision {
  if (message.content.some((part) => part.type === "toolCall")) {
    return { kind: "suppress" };
  }

  const text = sanitizeAssistantText(extractAssistantText(message));
  if (!text) return { kind: "empty" };
  // Marker silence and tool-call tails both mean do not deliver this message.
  if (isNoReplyMarker(text)) {
    return { kind: "suppress" };
  }
  // Strip the marker on every path so it never reaches a person. Only Event
  // Turn Delivery acts on `quiet`; other callers deliver the text as usual.
  const quietText = stripQuietMarker(text);
  if (quietText === undefined) return { kind: "deliver", text };
  return { kind: "deliver", text: quietText, quiet: true };
}

/** Return destination-visible reply text when the message is deliverable. */
export function getAssistantReplyText(
  message: AssistantMessage,
): string | undefined {
  const decision = decideReply(message);
  return decision.kind === "deliver" ? decision.text : undefined;
}
