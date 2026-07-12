import { countStructuredBlockChildren } from "../code";
import {
  parseMarkdownBlocks,
  stringifyPartValue,
  transcriptRoleKind,
} from "../format";
import { sameToolInvocation } from "../toolInvocations";
import type {
  TranscriptViewContextEventPart,
  TranscriptViewMessage,
  TranscriptViewPart,
  TranscriptViewSubagentPart,
} from "../types";

type RenderedToolPart =
  | { call: TranscriptViewPart; kind: "tool"; result?: TranscriptViewPart }
  | { call?: undefined; kind: "tool"; result: TranscriptViewPart };

export type RenderedTranscriptPart =
  | { kind: "part"; part: TranscriptViewPart }
  | RenderedToolPart;

export type RenderedTranscriptEntry =
  | RenderedContextEventEntry
  | { kind: "message"; message: TranscriptViewMessage }
  | RenderedSubagentEntry
  | RenderedThinkingEntry
  | RenderedToolEntry;

export type RenderedThinkingEntry = {
  kind: "thinking";
  part: TranscriptViewPart;
  timestamp?: number;
};

export type RenderedContextEventEntry = {
  kind: "context";
  part: TranscriptViewContextEventPart;
  timestamp?: number;
};

/** A single entry in a consecutive tool-and-thinking group. */
export type RenderedToolRunEntry = RenderedToolEntry | RenderedThinkingEntry;

export type RenderedSubagentEntry = {
  kind: "subagent";
  part: TranscriptViewSubagentPart;
  timestamp?: number;
};

export type RenderedToolEntry =
  | {
      call: TranscriptViewPart;
      kind: "tool";
      result?: TranscriptViewPart;
      resultTimestamp?: number;
      timestamp?: number;
    }
  | {
      call?: undefined;
      kind: "tool";
      result: TranscriptViewPart;
      resultTimestamp?: number;
      timestamp?: never;
    };

type RenderedToolCallEntry = Extract<
  RenderedToolEntry,
  { call: TranscriptViewPart }
>;

function isRenderedToolCallEntry(
  entry: RenderedTranscriptEntry,
): entry is RenderedToolCallEntry {
  return entry.kind === "tool" && entry.call !== undefined;
}

export type TranscriptViewMode = "raw" | "rich";

function isToolCall(part: TranscriptViewPart): boolean {
  return part.type === "tool_call";
}

function isToolResult(part: TranscriptViewPart): boolean {
  return part.type === "tool_result";
}

function isThinking(part: TranscriptViewPart): boolean {
  return part.type === "thinking";
}

function isSubagent(
  part: TranscriptViewPart,
): part is TranscriptViewSubagentPart {
  return part.type === "subagent";
}

function isContextEvent(
  part: TranscriptViewPart,
): part is TranscriptViewContextEventPart {
  return part.type === "context_event";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Group inline transcript parts so matching tool calls/results render together. */
export function groupTranscriptParts(
  parts: TranscriptViewPart[],
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

/** Pair exact IDs across event rows and unique name-only calls before a message boundary. */
function findToolEntry(
  entries: RenderedTranscriptEntry[],
  result: TranscriptViewPart,
): RenderedToolCallEntry | undefined {
  const nameCandidates: RenderedToolCallEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== "tool") {
      if (!result.id && entry.kind === "message") break;
      continue;
    }
    if (!isRenderedToolCallEntry(entry) || entry.result) continue;

    if (result.id) {
      if (sameToolInvocation(entry.call, result)) return entry;
      continue;
    }

    if (entry.call.name && entry.call.name === result.name) {
      nameCandidates.push(entry);
    }
  }

  const [candidate] = nameCandidates;
  return nameCandidates.length === 1 && !candidate?.call.id
    ? candidate
    : undefined;
}

/** Flatten message-local tool parts into conversation events for scan-friendly rendering. */
export function groupTranscriptMessages(
  messages: TranscriptViewMessage[],
): RenderedTranscriptEntry[] {
  const entries: RenderedTranscriptEntry[] = [];

  for (const message of messages) {
    let messageParts: TranscriptViewPart[] = [];
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

      if (isThinking(part)) {
        flushMessage();
        entries.push({
          kind: "thinking",
          part,
          timestamp: message.timestamp,
        });
        continue;
      }

      if (isSubagent(part)) {
        flushMessage();
        entries.push({
          kind: "subagent",
          part,
          timestamp: message.timestamp,
        });
        continue;
      }

      if (isContextEvent(part)) {
        flushMessage();
        entries.push({
          kind: "context",
          part,
          timestamp: message.timestamp,
        });
        continue;
      }

      messageParts.push(part);
    }

    flushMessage();
  }

  return entries;
}

/** Build the plain-text clipboard/raw view for one transcript message. */
export function messageRawText(message: TranscriptViewMessage): string {
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
      if (part.type === "subagent") {
        return [
          `subagent ${part.subagentKind}`,
          stringifyPartValue({
            id: part.id,
            outcome: part.outcome,
            parentToolCallId: part.parentToolCallId,
            status: part.status,
          }),
        ]
          .filter(isString)
          .join("\n");
      }
      if (part.type === "context_event") {
        const event = part.event;
        return event.type === "model_handoff"
          ? ["model handoff", event.fromModelId, event.toModelId, event.summary]
              .filter(isString)
              .join("\n")
          : ["context compacted", event.modelId, event.summary]
              .filter(isString)
              .join("\n");
      }
      return stringifyPartValue(part.output ?? part.input ?? part.text ?? part);
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

function countTextRenderedChildren(text: string, outputOnly: boolean): number {
  return parseMarkdownBlocks(text, { outputOnly }).reduce((count, block) => {
    return count + countStructuredBlockChildren(block);
  }, 0);
}

/** Count rendered rows so structured transcript expansion opens the newest node. */
export function countRenderedTranscriptChildren(
  part: RenderedTranscriptPart,
  role?: string,
): number {
  if (part.kind === "tool") return 1;
  if (part.part.type === "text") {
    return countTextRenderedChildren(
      part.part.text ?? "",
      transcriptRoleKind(role ?? "") === "assistant",
    );
  }
  return 1;
}
