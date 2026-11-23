import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Nodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { isLegacyNoReplyMarker } from "@/chat/no-reply";
import { extractAssistantText } from "@/chat/pi/transcript";

// The model's own `<thinking>` text in a reply, not a prompt tag.
const THINKING_XML_BLOCK_PATTERN =
  // oxlint-disable-next-line junior/no-prompt-tag-matching
  /[ \t]*<thinking\b[^>]*>[\s\S]*?<\/thinking>[ \t]*(?:\r?\n)?/gi;

type ReplyDecision =
  | { kind: "deliver"; text: string }
  | { kind: "empty" }
  | { kind: "suppress" };

// Whether a code block's source is a fenced block with a closing fence. An
// indented block is not, and neither is a fence with no closing line: it runs
// to the end of the text, so it would keep any later reasoning wrapper.
function isClosedFence(source: string): boolean {
  const opener = source.trimStart();
  const marker = opener.startsWith("```")
    ? "`"
    : opener.startsWith("~~~")
      ? "~"
      : undefined;
  const lastLine = source.lastIndexOf("\n");
  const closer = lastLine < 0 ? "" : source.slice(lastLine + 1).trim();
  return (
    marker !== undefined &&
    closer.length >= 3 &&
    closer === marker.repeat(closer.length)
  );
}

// The `[start, end)` source ranges of the closed fenced code blocks in
// Markdown, in text order. An indented line is not code here: reasoning
// wrappers can be indented.
function fencedCodeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const visit = (node: Nodes) => {
    if (node.type === "code") {
      const start = node.position?.start.offset ?? 0;
      const end = node.position?.end.offset ?? 0;
      if (isClosedFence(text.slice(start, end))) ranges.push([start, end]);
    } else if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(fromMarkdown(text));
  return ranges;
}

/** Remove provider reasoning wrappers while preserving fenced code examples. */
export function sanitizeAssistantText(text: string): string {
  let result = "";
  let cursor = 0;
  for (const [start, end] of fencedCodeRanges(text)) {
    result += text.slice(cursor, start).replace(THINKING_XML_BLOCK_PATTERN, "");
    result += text.slice(start, end);
    cursor = end;
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
  // Old history ends some Turns with a marker, and the model can copy one.
  // That text must never reach a person.
  if (isLegacyNoReplyMarker(text)) {
    return { kind: "suppress" };
  }
  return { kind: "deliver", text };
}

/** Return destination-visible reply text when the message is deliverable. */
export function getAssistantReplyText(
  message: AssistantMessage,
): string | undefined {
  const decision = decideReply(message);
  return decision.kind === "deliver" ? decision.text : undefined;
}
