import { countStructuredBlockChildren } from "../code";
import { parseMarkdownBlocks, stringifyPartValue } from "../format";
import type { TranscriptMessage, TranscriptPart } from "../types";

export type RenderedTranscriptPart =
  | { kind: "part"; part: TranscriptPart }
  | { kind: "tool"; call?: TranscriptPart; result?: TranscriptPart };

type RenderedTranscriptEntry =
  | { kind: "message"; message: TranscriptMessage }
  | RenderedToolEntry;

type RenderedToolEntry = {
  call?: TranscriptPart;
  kind: "tool";
  result?: TranscriptPart;
  resultTimestamp?: number;
  timestamp?: number;
};

export type TranscriptViewMode = "raw" | "rich";

function isToolCall(part: TranscriptPart): boolean {
  return part.type === "tool_call";
}

function isToolResult(part: TranscriptPart): boolean {
  return part.type === "tool_result";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameToolInvocation(
  call: TranscriptPart,
  result: TranscriptPart,
): boolean {
  if (call.id && result.id) return call.id === result.id;
  if (call.name && result.name) return call.name === result.name;
  return false;
}

/** Group inline transcript parts so matching tool calls/results render together. */
export function groupTranscriptParts(
  parts: TranscriptPart[],
): RenderedTranscriptPart[] {
  const grouped: RenderedTranscriptPart[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < parts.length; index += 1) {
    if (consumed.has(index)) continue;

    const part = parts[index]!;
    if (isToolCall(part)) {
      const resultIndex = parts.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          !consumed.has(candidateIndex) &&
          isToolResult(candidate) &&
          sameToolInvocation(part, candidate),
      );
      if (resultIndex >= 0) {
        consumed.add(resultIndex);
        grouped.push({ kind: "tool", call: part, result: parts[resultIndex] });
      } else {
        grouped.push({ kind: "tool", call: part });
      }
      continue;
    }

    if (isToolResult(part)) {
      grouped.push({ kind: "tool", result: part });
      continue;
    }

    grouped.push({ kind: "part", part });
  }

  return grouped;
}

function findToolEntry(
  entries: RenderedTranscriptEntry[],
  result: TranscriptPart,
): RenderedToolEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "tool" || entry.result) continue;
    if (!entry.call || sameToolInvocation(entry.call, result)) {
      return entry;
    }
  }
  return undefined;
}

/** Flatten message-local tool parts into turn-level events for scan-friendly rendering. */
export function groupTranscriptMessages(
  messages: TranscriptMessage[],
): RenderedTranscriptEntry[] {
  const entries: RenderedTranscriptEntry[] = [];

  for (const message of messages) {
    let messageParts: TranscriptPart[] = [];
    const flushMessage = () => {
      if (messageParts.length === 0) return;
      entries.push({
        kind: "message",
        message: { ...message, parts: messageParts },
      });
      messageParts = [];
    };

    for (const part of message.parts) {
      if (isToolCall(part)) {
        flushMessage();
        entries.push({
          call: part,
          kind: "tool",
          timestamp: message.timestamp,
        });
        continue;
      }

      if (isToolResult(part)) {
        flushMessage();
        const entry = findToolEntry(entries, part);
        if (entry) {
          entry.result = part;
          entry.resultTimestamp = message.timestamp;
        } else {
          entries.push({
            kind: "tool",
            result: part,
            resultTimestamp: message.timestamp,
          });
        }
        continue;
      }

      messageParts.push(part);
    }

    flushMessage();
  }

  return entries;
}

/** Build the plain-text clipboard/raw view for one transcript message. */
export function messageRawText(message: TranscriptMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "thinking") return stringifyPartValue(part.output);
      if (part.type === "tool_call") {
        return [
          `tool_call ${part.name ?? part.id ?? "unknown"}`,
          stringifyPartValue(part.input),
        ]
          .filter(isString)
          .join("\n");
      }
      if (part.type === "tool_result") {
        return [
          `tool_result ${part.name ?? part.id ?? "unknown"}`,
          stringifyPartValue(part.output),
        ]
          .filter(isString)
          .join("\n");
      }
      return stringifyPartValue(part.output ?? part.input ?? part.text ?? part);
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function countTextRenderedChildren(text: string): number {
  return parseMarkdownBlocks(text).reduce((count, block) => {
    return count + countStructuredBlockChildren(block);
  }, 0);
}

/** Count rendered rows so structured transcript expansion opens the newest node. */
export function countRenderedTranscriptChildren(
  part: RenderedTranscriptPart,
): number {
  if (part.kind === "tool") return 1;
  if (part.part.type === "text") {
    return countTextRenderedChildren(part.part.text ?? "");
  }
  return 1;
}
