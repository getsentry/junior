import type { ConversationEvent } from "@/chat/conversations/history";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import { projectConversationEvents } from "@/chat/pi/conversation-events";
import type { PiMessage } from "@/chat/pi/messages";
import { stripRuntimeTurnContext } from "@/chat/pi/transcript";
import type { ModelProfile } from "@/chat/model-profile";
import { escapeXml } from "@/chat/xml";
import { estimateTextTokens } from "@/chat/services/context-budget";

const RAW_TAIL_TOKENS = 20_000;
export const SEGMENT_TOKENS = 16_000;
const MAX_SEGMENTS_PER_TURN = 6;

type DistillationEvent = ConversationEvent & {
  data: Extract<ConversationEvent["data"], { type: "distillation" }>;
};

export interface HistoryEntry {
  message: PiMessage;
  provenance: ConversationMessageProvenance;
  seq: number;
}

export interface DistillationSource {
  entries: HistoryEntry[];
  events: DistillationEvent[];
  historyVersion: number;
  terminalSeq: number;
}

function isDistillation(event: ConversationEvent): event is DistillationEvent {
  return event.data.type === "distillation";
}

/** Keep the latest anchored meta summary and the newer raw observation segments. */
export function activeDistillations(
  events: readonly ConversationEvent[],
): DistillationEvent[] {
  const records = events.filter(isDistillation);
  const meta = records.filter((event) => event.data.generation === 1).at(-1);
  return [
    ...(meta ? [meta] : []),
    ...records.filter(
      (event) =>
        event.data.generation === 0 &&
        (!meta || event.data.fromSeq > meta.data.throughSeq),
    ),
  ];
}

/** Select only completed, current-version history for one Conversation worker. */
export function distillationSource(args: {
  events: ConversationEvent[];
  profile: ModelProfile;
  turnId: string;
}): DistillationSource | undefined {
  const terminal = [...args.events]
    .reverse()
    .find(
      (event) =>
        event.data.type === "turn_completed" &&
        event.data.turnId === args.turnId,
    );
  if (!terminal) return undefined;
  const projection = projectConversationEvents(args.events, {
    defaultProfile: args.profile,
    maxSeq: terminal.seq,
  });
  const entries = projection.messages.flatMap((message, index) => {
    if (!["user", "assistant", "toolResult"].includes(message.role)) return [];
    return stripRuntimeTurnContext([message]).map((stripped) => ({
      message: stripped,
      provenance: projection.provenance[index]!,
      seq: projection.seqs[index]!,
    }));
  });
  return {
    entries,
    events: activeDistillations(args.events),
    historyVersion: terminal.historyVersion,
    terminalSeq: terminal.seq,
  };
}

function tokens(message: PiMessage): number {
  return estimateModelVisibleTokens([message]);
}

function readable(message: PiMessage): boolean {
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.every((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part)) return false;
    if (part.type === "text") {
      return "text" in part && typeof part.text === "string";
    }
    if (part.type === "thinking") {
      return "thinking" in part && typeof part.thinking === "string";
    }
    if (part.type === "toolCall") {
      return (
        "id" in part &&
        typeof part.id === "string" &&
        "name" in part &&
        typeof part.name === "string" &&
        "arguments" in part &&
        typeof JSON.stringify(part.arguments) === "string"
      );
    }
    return false;
  });
}

/** Price request content, not past usage counters on assistant messages. */
export function estimateModelVisibleTokens(
  messages: readonly PiMessage[],
): number {
  return messages.reduce((total, message) => {
    const content = "content" in message ? message.content : undefined;
    return (
      total +
      estimateTextTokens(JSON.stringify({ role: message.role, content }))
    );
  }, 0);
}

function safeBoundary(
  entries: readonly HistoryEntry[],
  index: number,
): boolean {
  const message = entries[index]?.message;
  if (!message) return false;
  if (message.role === "assistant") {
    return !message.content.some((part) => part.type === "toolCall");
  }
  if (message.role === "toolResult") {
    return entries[index + 1]?.message.role !== "toolResult";
  }
  return false;
}

/** Leave the latest raw work in the model's view and keep tool pairs whole. */
export function pendingSegments(source: DistillationSource): HistoryEntry[][] {
  const lastCovered = source.events.at(-1)?.data.throughSeq ?? -1;
  const eligible = source.entries.filter((entry) => entry.seq > lastCovered);
  const total = eligible.reduce((sum, entry) => sum + tokens(entry.message), 0);
  if (total <= RAW_TAIL_TOKENS + SEGMENT_TOKENS) return [];

  let tailTokens = 0;
  let end = -1;
  for (let index = eligible.length - 1; index >= 0; index -= 1) {
    tailTokens += tokens(eligible[index]!.message);
    if (tailTokens >= RAW_TAIL_TOKENS && safeBoundary(eligible, index - 1)) {
      end = index;
      break;
    }
  }
  if (end < 1) return [];
  // Never mark an entry covered if the observer cannot read its full text.
  // Images and oversized entries stay raw for the existing capacity path.
  if (
    eligible
      .slice(0, end)
      .some(
        ({ message }) => tokens(message) > SEGMENT_TOKENS || !readable(message),
      )
  ) {
    return [];
  }

  const segments: HistoryEntry[][] = [];
  for (
    let start = 0;
    start < end && segments.length < MAX_SEGMENTS_PER_TURN;
  ) {
    let cost = 0;
    let split = -1;
    for (let index = start; index < end; index += 1) {
      const nextCost = cost + tokens(eligible[index]!.message);
      if (nextCost > SEGMENT_TOKENS) break;
      cost = nextCost;
      if (safeBoundary(eligible, index)) split = index + 1;
    }
    if (split < 0) break;
    segments.push(eligible.slice(start, split));
    start = split;
  }
  return segments;
}

function messageContentText(message: PiMessage): string {
  if (!readable(message)) {
    throw new Error("Cannot render an unreadable observation entry");
  }
  const content = "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (!part || typeof part !== "object" || !("type" in part)) return "";
      if (
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      if (
        part.type === "thinking" &&
        "thinking" in part &&
        typeof part.thinking === "string"
      ) {
        return `Thinking: ${part.thinking}`;
      }
      if (
        part.type === "toolCall" &&
        "id" in part &&
        "name" in part &&
        "arguments" in part
      ) {
        return `Called ${String(part.name)} (${String(part.id)}): ${JSON.stringify(part.arguments)}`;
      }
      throw new Error("Cannot render an unreadable observation part");
    })
    .filter(Boolean)
    .join("\n");
}

/** Render source history for Luna without logging content or raw image data. */
export function renderSegment(entries: readonly HistoryEntry[]): string {
  return entries
    .map(({ message, provenance }) => {
      const role =
        message.role === "user"
          ? provenance.authority === "instruction"
            ? "user instruction"
            : "context"
          : message.role === "toolResult"
            ? `tool result (${message.toolName}, call ${message.toolCallId}${message.isError ? ", error" : ""})`
            : "assistant";
      const content = messageContentText(message);
      return `${new Date(message.timestamp).toISOString()} ${role}: ${escapeXml(content)}`;
    })
    .join("\n\n");
}
