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

function specialToolIds(events: ConversationReportEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const data = event.data;
    if (data.type === "handoff" && data.triggeringToolCallId) {
      ids.add(data.triggeringToolCallId);
    }
    if (data.type === "subagent_started" && data.parentToolCallId) {
      ids.add(data.parentToolCallId);
    }
  }
  return ids;
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
  const replacedToolIds = specialToolIds(conversation.events);
  const tools = new Map<
    string,
    Extract<TranscriptViewPart, { type: "tool_call" }>
  >();
  const messages: TranscriptViewMessage[] = [];

  const ensureTool = (
    event: ConversationReportEvent,
    toolCallId: string,
    name: string,
  ): Extract<TranscriptViewPart, { type: "tool_call" }> | undefined => {
    if (replacedToolIds.has(toolCallId)) return undefined;
    const existing = tools.get(toolCallId);
    if (existing) return existing;
    const part = {
      type: "tool_call" as const,
      id: toolCallId,
      name,
      status: "running" as const,
    };
    tools.set(toolCallId, part);
    messages.push(eventMessage(event, "tool", [part]));
    return part;
  };

  // API sequence is the only ordering authority. Do not sort by timestamps:
  // producers may preserve ingestion order while clocks are skewed.
  for (const event of conversation.events) {
    const data = event.data;
    if (data.type === "message") {
      messages.push({
        ...eventMessage(event, data.role, [
          data.redacted
            ? { type: "text", redacted: true }
            : { type: "text", text: data.text! },
        ]),
        ...(data.eventType ? { eventType: data.eventType } : {}),
      });
      continue;
    }

    if (data.type === "tool_started") {
      ensureTool(event, data.toolCallId, data.name);
      continue;
    }

    if (data.type === "tool_calls") {
      for (const call of data.calls) {
        const part = ensureTool(event, call.toolCallId, call.name);
        if (part && call.input !== undefined) part.input = call.input;
      }
      continue;
    }

    if (data.type === "tool_result") {
      const part = tools.get(data.toolCallId);
      if (part) {
        part.status = data.outcome;
        part.resultTimestamp = eventTimestamp(event);
        if (data.output !== undefined) part.output = data.output;
      }
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
            event:
              data.type === "handoff"
                ? {
                    type: data.type,
                    createdAt: event.createdAt,
                    modelId: data.modelId,
                    modelProfile: data.modelProfile,
                    ...(data.reasoningLevel
                      ? { reasoningLevel: data.reasoningLevel }
                      : {}),
                  }
                : { type: data.type, createdAt: event.createdAt },
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
