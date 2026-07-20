import type { ConversationReportEvent } from "@sentry/junior/api/schema";

import type {
  ConversationTranscript,
  TranscriptViewMessage,
  TranscriptViewPart,
  TranscriptViewSubagentPart,
} from "./types";

function eventTimestamp(event: ConversationReportEvent): number {
  return Date.parse(event.createdAt);
}

function eventMessage(
  event: ConversationReportEvent,
  role: TranscriptViewMessage["role"],
  parts: TranscriptViewPart[],
): TranscriptViewMessage {
  return { role, timestamp: eventTimestamp(event), parts };
}

function subagentOutcomes(
  events: ConversationReportEvent[],
): Map<
  number,
  Extract<
    ConversationReportEvent["data"],
    { type: "subagent_ended" }
  >["outcome"]
> {
  const outcomes = new Map<
    number,
    Extract<
      ConversationReportEvent["data"],
      { type: "subagent_ended" }
    >["outcome"]
  >();
  for (const event of events) {
    if (event.data.type === "subagent_ended") {
      outcomes.set(event.data.startedSeq, event.data.outcome);
    }
  }
  return outcomes;
}

function specialToolStarts(events: ConversationReportEvent[]): Set<number> {
  const starts = new Set<number>();
  for (const event of events) {
    const data = event.data;
    if (
      (data.type === "handoff" || data.type === "subagent_started") &&
      data.toolStartedSeq !== undefined
    ) {
      starts.add(data.toolStartedSeq);
    }
  }
  return starts;
}

function subagentPart(
  data: Extract<ConversationReportEvent["data"], { type: "subagent_started" }>,
  outcome: "aborted" | "error" | "success" | undefined,
): TranscriptViewSubagentPart {
  return {
    type: "subagent",
    id: data.childConversationId,
    childConversationId: data.childConversationId,
    subagentKind: data.subagentKind,
    status:
      outcome === "error" || outcome === "aborted"
        ? outcome
        : outcome === "success"
          ? "completed"
          : "running",
  };
}

/** Reduce the ordered reporting event API into dashboard-only transcript rows. */
export function conversationTranscriptMessages(
  conversation: ConversationTranscript,
): TranscriptViewMessage[] {
  const outcomes = subagentOutcomes(conversation.events);
  const replacedToolStarts = specialToolStarts(conversation.events);
  const messages: TranscriptViewMessage[] = [];

  // API sequence is the only ordering authority. Do not sort by timestamps:
  // producers may preserve ingestion order while clocks are skewed.
  for (const event of conversation.events) {
    const data = event.data;
    if (data.type === "message") {
      messages.push(
        eventMessage(event, data.role, [
          data.redacted
            ? { type: "text", redacted: true }
            : { type: "text", text: data.text! },
        ]),
      );
      continue;
    }

    if (data.type === "tool_started") {
      if (replacedToolStarts.has(event.seq)) continue;
      messages.push(
        eventMessage(event, "tool", [
          // Reporting intentionally has no completion state. This is a neutral
          // structural start row, not a claim that the tool is still running.
          { type: "tool_call", name: data.name },
        ]),
      );
      continue;
    }

    if (data.type === "subagent_started") {
      messages.push(
        eventMessage(event, "tool", [
          subagentPart(data, outcomes.get(event.seq)),
        ]),
      );
      continue;
    }

    if (data.type === "compaction" || data.type === "handoff") {
      messages.push(
        eventMessage(event, "system", [
          {
            type: "context_event",
            event: { type: data.type, createdAt: event.createdAt },
          },
        ]),
      );
      continue;
    }

    if (data.type === "turn_lifecycle" && data.state === "failed") {
      messages.push({
        role: data.failureKind === "delivery" ? "system" : "assistant",
        outcome: data.failureKind === "delivery" ? "delivery_failed" : "error",
        parts: [],
        timestamp: eventTimestamp(event),
      });
      continue;
    }
  }

  return messages;
}
