import type {
  TranscriptViewContextEventPart,
  TranscriptViewMessage,
  TranscriptViewSubagentPart,
  TranscriptViewTextPart,
  TranscriptViewToolCallPart,
} from "../types";

export type RenderedFailureEntry = {
  key: string;
  kind: "failure";
  outcome: "error" | "delivery_failed";
  timestamp?: number;
};

export type RenderedContextEventEntry = {
  key: string;
  kind: "context";
  part: TranscriptViewContextEventPart;
  timestamp?: number;
};

export type RenderedSubagentEntry = {
  key: string;
  kind: "subagent";
  part: TranscriptViewSubagentPart;
  timestamp?: number;
};

export type RenderedToolEntry = {
  key: string;
  kind: "tool";
  part: TranscriptViewToolCallPart;
  timestamp?: number;
};

export type RenderedMessageEntry = {
  key: string;
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
    let textGroup = 0;
    const flushMessage = () => {
      if (textParts.length === 0) return;
      entries.push({
        key: `${message.sourceSeq}:message:${textGroup}`,
        kind: "message",
        message: { ...message, parts: textParts },
      });
      textParts = [];
      textGroup += 1;
    };

    for (const [partIndex, part] of message.parts.entries()) {
      if (part.type === "text") {
        textParts.push(part);
        continue;
      }

      flushMessage();
      if (part.type === "tool_call") {
        entries.push({
          key: `tool:${part.id}`,
          kind: "tool",
          part,
          timestamp: message.timestamp,
        });
      } else if (part.type === "subagent") {
        entries.push({
          key: `subagent:${part.id}`,
          kind: "subagent",
          part,
          timestamp: message.timestamp,
        });
      } else {
        entries.push({
          key: `${message.sourceSeq}:context:${partIndex}`,
          kind: "context",
          part,
          timestamp: message.timestamp,
        });
      }
    }

    flushMessage();
    if (message.outcome) {
      entries.push({
        key: `${message.sourceSeq}:failure`,
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
      if (part.event.type !== "handoff") {
        return ["context compacted", part.event.summary]
          .filter((line): line is string => line !== undefined)
          .join("\n");
      }
      return [
        "model handoff",
        `profile ${part.event.modelProfile}`,
        `model ${part.event.modelId}`,
        part.event.summary,
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
