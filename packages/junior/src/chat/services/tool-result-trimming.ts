/**
 * Tool-result trimming for replacement histories.
 *
 * A history replacement breaks the prompt cache anyway, so it is the cheap
 * time to shrink old tool results. The full result stays in the conversation
 * event log. A trimmed result names the event `seq` that
 * `readConversationEvent` reads back.
 */
import type { PiMessage } from "@/chat/pi/messages";
import { hasTurnInput } from "@/chat/pi/transcript";

/** Results up to this many text characters stay whole. */
const MAX_KEPT_RESULT_CHARS = 2_000;
/** Error results explain failures, so they stay whole up to this size. */
const MAX_KEPT_ERROR_CHARS = 8_000;
const EDGE_CHARS = 500;

/** One replacement-history message and the event it was copied from. */
export interface TrimmableEntry {
  message: PiMessage;
  sourceEventSeq?: number | undefined;
}

/** Counts of what trimming removed, for telemetry. */
export interface ToolResultTrimming {
  trimmedResults: number;
  removedChars: number;
}

interface ToolResultPart {
  type?: unknown;
  text?: unknown;
}

function role(message: PiMessage): unknown {
  return (message as { role?: unknown }).role;
}

function resultParts(message: PiMessage): ToolResultPart[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ToolResultPart[]) : [];
}

function resultText(parts: ToolResultPart[]): string {
  return parts
    .map((part) =>
      part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

function pointer(seq: number): string {
  return `readConversationEvent({ seq: ${seq} })`;
}

/** Replace a long result text with a header, its edges, and a read-back pointer. */
function clearedText(toolName: string, text: string, seq: number): string {
  return [
    `[Tool result cleared to save context: ${toolName}, ${text.length.toLocaleString("en-US")} chars. Full result: ${pointer(seq)}`,
    "First 500 chars:",
    text.slice(0, EDGE_CHARS),
    "Last 500 chars:",
    `${text.slice(-EDGE_CHARS)}]`,
  ].join("\n");
}

function trimResult(
  message: PiMessage,
  seq: number,
): { message: PiMessage; removedChars: number } | undefined {
  const parts = resultParts(message);
  const text = resultText(parts);
  const hasImage = parts.some((part) => part.type === "image");
  const isError = (message as { isError?: unknown }).isError === true;
  const keptChars = isError ? MAX_KEPT_ERROR_CHARS : MAX_KEPT_RESULT_CHARS;
  const clearText = text.length > keptChars;
  if (!clearText && !hasImage) {
    return undefined;
  }
  const toolName = String(
    (message as { toolName?: unknown }).toolName ?? "tool",
  );
  const content = clearText
    ? [{ type: "text", text: clearedText(toolName, text, seq) }]
    : parts.map((part) =>
        part.type === "image"
          ? { type: "text", text: `[image cleared: ${toolName}, seq ${seq}]` }
          : part,
      );
  if (clearText && hasImage) {
    content.push({
      type: "text",
      text: `[image cleared: ${toolName}, seq ${seq}]`,
    });
  }
  return {
    // The tool call id stays, so the result still pairs with its call.
    message: { ...message, content } as PiMessage,
    removedChars: Math.max(0, text.length - resultText(content).length),
  };
}

/**
 * Trim old tool results in a replacement history.
 *
 * Results after the last Turn instruction belong to the latest Turn and stay
 * whole. Runtime context and summaries are user messages too, so they do not
 * mark a Turn. So do short results, error results up to a cap, and
 * results that have no source event to point to. Images outside the latest
 * Turn become a short note.
 */
export function trimToolResults<T extends TrimmableEntry>(
  entries: T[],
): { entries: T[]; trimming: ToolResultTrimming } {
  let latestInstructionIndex = -1;
  entries.forEach((entry, index) => {
    if (hasTurnInput(entry.message)) latestInstructionIndex = index;
  });
  const trimming: ToolResultTrimming = { trimmedResults: 0, removedChars: 0 };
  const trimmed = entries.map((entry, index) => {
    if (
      index > latestInstructionIndex ||
      role(entry.message) !== "toolResult" ||
      entry.sourceEventSeq === undefined
    ) {
      return entry;
    }
    const result = trimResult(entry.message, entry.sourceEventSeq);
    if (!result) {
      return entry;
    }
    trimming.trimmedResults += 1;
    trimming.removedChars += result.removedChars;
    return { ...entry, message: result.message };
  });
  return { entries: trimmed, trimming };
}
