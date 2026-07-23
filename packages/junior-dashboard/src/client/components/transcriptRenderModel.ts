import type {
  TranscriptViewContextEventPart,
  TranscriptViewMessage,
  TranscriptViewSubagentPart,
  TranscriptViewTextPart,
  TranscriptViewToolCallPart,
} from "../types";

export type RenderedFailureEntry = {
  kind: "failure";
  outcome: "error" | "delivery_failed";
  timestamp?: number;
};

export type RenderedContextEventEntry = {
  kind: "context";
  part: TranscriptViewContextEventPart;
  timestamp?: number;
};

export type RenderedSubagentEntry = {
  kind: "subagent";
  part: TranscriptViewSubagentPart;
  timestamp?: number;
};

export type RenderedToolEntry = {
  kind: "tool";
  part: TranscriptViewToolCallPart;
  timestamp?: number;
};

export type RenderedMessageEntry = {
  kind: "message";
  message: Omit<TranscriptViewMessage, "parts"> & {
    parts: TranscriptViewTextPart[];
  };
};

export type RenderedTranscriptEntry =
  | RenderedContextEventEntry
  | RenderedFailureEntry
  | RenderedMessageEntry
  | RenderedSubagentEntry
  | RenderedToolEntry;

export type TranscriptViewMode = "raw" | "rich";

/** Flatten canonical dashboard messages into their reachable display rows. */
export function groupTranscriptMessages(
  messages: TranscriptViewMessage[],
): RenderedTranscriptEntry[] {
  const entries: RenderedTranscriptEntry[] = [];

  for (const message of messages) {
    let textParts: TranscriptViewTextPart[] = [];
    const flushMessage = () => {
      if (textParts.length === 0) return;
      entries.push({
        kind: "message",
        message: { ...message, parts: textParts },
      });
      textParts = [];
    };

    for (const part of message.parts) {
      if (part.type === "text") {
        textParts.push(part);
        continue;
      }

      flushMessage();
      if (part.type === "tool_call") {
        entries.push({ kind: "tool", part, timestamp: message.timestamp });
      } else if (part.type === "subagent") {
        entries.push({ kind: "subagent", part, timestamp: message.timestamp });
      } else {
        entries.push({ kind: "context", part, timestamp: message.timestamp });
      }
    }

    flushMessage();
    if (message.outcome) {
      entries.push({
        kind: "failure",
        outcome: message.outcome,
        timestamp: message.timestamp,
      });
    }
  }

  return entries;
}

/** Build the plain-text clipboard/raw view for one canonical message. */
export function messageRawText(message: TranscriptViewMessage): string {
  return message.parts
    .map((part) => {
      if (part.type === "text") return part.text ?? "";
      if (part.type === "tool_call") return `tool_call ${part.name}`;
      if (part.type === "subagent") {
        return `subagent ${part.subagentKind}\nstatus ${part.status}`;
      }
      if (part.event.type !== "handoff") return "context compacted";
      return [
        "model handoff",
        `profile ${part.event.modelProfile}`,
        `model ${part.event.modelId}`,
        part.event.reasoningLevel
          ? `reasoning ${part.event.reasoningLevel}`
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    })
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}
