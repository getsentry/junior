import { estimateTextTokens } from "@/chat/services/token-estimate";
import type { BenchEvent } from "./events";

/** One model-visible history entry, rendered as text. */
export interface BenchMessage {
  seq: number;
  role: "user" | "assistant" | "toolResult" | "system" | "summary";
  authority: "instruction" | "context" | undefined;
  createdAt: string;
  text: string;
  tokens: number;
}

/** History around one recorded capacity compaction. */
export interface CompactionPoint {
  index: number;
  seq: number;
  /** History version the compaction created. */
  version: number;
  /** Last seq the summary request saw. */
  markSeq: number;
  createdAt: string;
  details: {
    estimatedInputTokens: number;
    replacementInputTokens: number;
    inputMessageCount: number;
    retainedMessageCount: number;
    summaryChars: number;
  };
  recordedSummary: string;
  /** Recorded cost of today's summary call, from `compaction_prepared`. */
  recordedSummaryCostUsd: number | undefined;
  /** Summary that the compacted history carried in, if any. */
  previousSummary: string | undefined;
  /** Raw entries that this compaction removed from model view. */
  dropped: BenchMessage[];
  /** Raw entries kept after the summary. */
  tail: BenchMessage[];
  /** Raw entries kept beyond the tail. Empty: the tail is counted at the compaction. */
  after: BenchMessage[];
  /** Rebuilt message count before compaction; compare with `inputMessageCount`. */
  rebuiltInputMessages: number;
  /** Assistant calls made in the version this compaction created. */
  nextVersionCalls: number;
  /** Recorded prompt and output tokens of each of those calls, in order. */
  nextVersionPrompts: Array<{ prompt: number; output: number }>;
  /** Seq where the next compaction happens, or the last seq. */
  windowEndSeq: number;
}

const MESSAGE_TYPES = new Set([
  "user_message",
  "assistant_message",
  "tool_result",
  "system_message",
]);

function partText(part: unknown): string {
  if (!part || typeof part !== "object" || !("type" in part)) return "";
  const value = part as {
    type?: unknown;
    text?: unknown;
    name?: unknown;
    arguments?: unknown;
  };
  if (value.type === "text" && typeof value.text === "string")
    return value.text;
  if (value.type === "toolCall") {
    return `[tool call: ${String(value.name)} ${JSON.stringify(value.arguments)}]`;
  }
  if (value.type === "image") return "[image]";
  // Thinking is not replayed to the next model call.
  return "";
}

/** Render one event's message content as plain text. */
export function eventText(data: BenchEvent["data"]): string {
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) {
    return data.content.map(partText).filter(Boolean).join("\n");
  }
  return "";
}

function authority(
  data: BenchEvent["data"],
  text: string,
): BenchMessage["authority"] {
  const provenance = data.provenance as { authority?: string } | undefined;
  if (provenance?.authority === "instruction") return "instruction";
  if (provenance?.authority === "context") return "context";
  // Exported payloads lose provenance; the instruction marker survives.
  return /<current-instruction|<review-item-answer/.test(text)
    ? "instruction"
    : "context";
}

function toMessage(event: BenchEvent): BenchMessage {
  const text = eventText(event.data);
  const role =
    event.data.type === "user_message"
      ? "user"
      : event.data.type === "assistant_message"
        ? "assistant"
        : event.data.type === "tool_result"
          ? "toolResult"
          : "system";
  return {
    seq: event.seq,
    role,
    authority: role === "user" ? authority(event.data, text) : undefined,
    createdAt: event.createdAt,
    text,
    tokens: estimateTextTokens(text),
  };
}

/**
 * Replay the event log into model-visible history and cut it at each
 * recorded capacity compaction. The exported compaction event carries only
 * the retained count, so the tail is the last `retainedMessageCount` entries
 * up to `markSeq`.
 */
export function rebuildCompactions(
  events: readonly BenchEvent[],
): CompactionPoint[] {
  const requests = new Map<number, number>();
  const prepared = new Map<number, number>();
  const points: CompactionPoint[] = [];
  let history: BenchMessage[] = [];
  const assistantSeqs: number[] = [];
  const usage = new Map<number, { prompt: number; output: number }>();

  for (const event of events) {
    const data = event.data;
    if (MESSAGE_TYPES.has(data.type)) {
      const message = toMessage(event);
      history.push(message);
      if (message.role === "assistant") {
        assistantSeqs.push(event.seq);
        const recorded = data["usage"] as
          | {
              input?: number;
              cacheRead?: number;
              cacheWrite?: number;
              output?: number;
            }
          | undefined;
        if (recorded) {
          usage.set(event.seq, {
            prompt:
              (recorded.input ?? 0) +
              (recorded.cacheRead ?? 0) +
              (recorded.cacheWrite ?? 0),
            output: recorded.output ?? 0,
          });
        }
      }
      continue;
    }
    if (data.type === "compaction_requested") {
      requests.set(Number(data.historyVersion), Number(data.markSeq));
      continue;
    }
    if (data.type === "compaction_prepared") {
      if (typeof data.costUsd === "number") {
        prepared.set(Number(data.markSeq), data.costUsd);
      }
      continue;
    }
    if (data.type !== "compaction") continue;

    const details = data.details as CompactionPoint["details"] | undefined;
    if (!details) {
      throw new Error(
        `Compaction at seq ${event.seq} has no payload. Finish the export and rerun merge.`,
      );
    }
    const markSeq = requests.get(event.historyVersion - 1) ?? event.seq;
    // The summary may have been prepared at an earlier mark, but the
    // replacement keeps the last `retainedMessageCount` entries of the
    // history at the compaction itself, which `inputMessageCount` counts.
    const keep = Math.min(details.retainedMessageCount, history.length);
    const removed = history.slice(0, history.length - keep);
    const after: BenchMessage[] = [];
    const summary = String(data.summary ?? "");
    points.push({
      index: points.length,
      seq: event.seq,
      version: event.historyVersion,
      markSeq,
      createdAt: event.createdAt,
      details,
      recordedSummary: summary,
      recordedSummaryCostUsd: prepared.get(markSeq),
      previousSummary: removed.find((message) => message.role === "summary")
        ?.text,
      dropped: removed.filter((message) => message.role !== "summary"),
      tail: history.slice(history.length - keep),
      after,
      rebuiltInputMessages: history.length,
      nextVersionCalls: 0,
      nextVersionPrompts: [],
      windowEndSeq: 0,
    });
    history = [
      {
        seq: event.seq,
        role: "summary",
        authority: "context",
        createdAt: event.createdAt,
        text: summary,
        tokens: estimateTextTokens(summary),
      },
      ...history.slice(history.length - keep),
    ];
  }

  const lastSeq = events.at(-1)?.seq ?? 0;
  for (const point of points) {
    point.windowEndSeq = points[point.index + 1]?.seq ?? lastSeq;
    const calls = assistantSeqs.filter(
      (seq) => seq > point.seq && seq <= point.windowEndSeq,
    );
    point.nextVersionCalls = calls.length;
    point.nextVersionPrompts = calls.flatMap((seq) => {
      const recorded = usage.get(seq);
      return recorded ? [recorded] : [];
    });
  }
  return points;
}

/** Render entries in the #2050 observer source format. */
export function renderMessages(messages: readonly BenchMessage[]): string {
  return messages
    .map((message) => {
      const role =
        message.role === "user"
          ? message.authority === "instruction"
            ? "user instruction"
            : "context"
          : message.role === "toolResult"
            ? "tool result"
            : message.role;
      return `${message.createdAt} ${role}: ${message.text}`;
    })
    .join("\n\n");
}

const SEGMENT_TOKENS = 16_000;

/**
 * Split removed history into #2050-sized observer segments. Oversized
 * entries are cut to the segment budget instead of left raw, since this
 * history is already gone from model view.
 */
export function segments(messages: readonly BenchMessage[]): BenchMessage[][] {
  const result: BenchMessage[][] = [];
  let current: BenchMessage[] = [];
  let tokens = 0;
  for (const original of messages) {
    const message =
      original.tokens > SEGMENT_TOKENS
        ? {
            ...original,
            text: `${original.text.slice(0, SEGMENT_TOKENS * 3)}\n[truncated]`,
            tokens: SEGMENT_TOKENS,
          }
        : original;
    // Keep a tool result with the call before it.
    if (
      tokens + message.tokens > SEGMENT_TOKENS &&
      current.length > 0 &&
      message.role !== "toolResult"
    ) {
      result.push(current);
      current = [];
      tokens = 0;
    }
    current.push(message);
    tokens += message.tokens;
  }
  if (current.length) result.push(current);
  return result;
}

/** Model-visible messages with seqs in `(fromSeq, toSeq)`. */
export function messagesBetween(
  events: readonly BenchEvent[],
  fromSeq: number,
  toSeq: number,
): BenchMessage[] {
  return events
    .filter(
      (event) =>
        event.seq > fromSeq &&
        event.seq < toSeq &&
        MESSAGE_TYPES.has(event.data.type),
    )
    .map(toMessage);
}
