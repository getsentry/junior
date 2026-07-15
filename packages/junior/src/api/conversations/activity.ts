import type {
  ConversationEvent,
  ConversationEventData,
} from "@/chat/conversations/history";
import { redactedPayloadFields } from "./transcript";
import type {
  ConversationActivityReport,
  ConversationActivityStatus,
  ConversationSubagentActivityReport,
} from "./schema";

interface ActivityPayloadMetadata {
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
}
function toolResultStatuses(
  events: ConversationEvent[],
): Map<string, ConversationActivityStatus> {
  const statuses = new Map<string, ConversationActivityStatus>();
  for (const event of events) {
    if (event.data.type !== "message") continue;
    const record = event.data.message as Record<string, unknown>;
    if (record.role !== "toolResult" || typeof record.toolCallId !== "string") {
      continue;
    }
    statuses.set(record.toolCallId, record.isError ? "error" : "completed");
  }
  return statuses;
}

function activityPayloadFields(
  args: unknown,
  canExposePayload: boolean,
): ActivityPayloadMetadata & { args?: unknown; redacted?: boolean } {
  if (args === undefined) {
    return {};
  }
  return canExposePayload
    ? { args }
    : { redacted: true, ...redactedPayloadFields("input", args) };
}

/**
 * Build the current-run activity timeline from durable conversation events.
 *
 * Tool executions, subagent starts/ends, and their nesting are derived from the
 * conversation's durable events instead of the legacy Redis session log; tool
 * statuses come from durable model-message events. Redaction stays
 * byte-compatible with the prior session-log path.
 */
export function buildConversationActivityFromEvents(args: {
  canExposePayload: boolean;
  events: ConversationEvent[];
}): ConversationActivityReport[] {
  const toolStatuses = toolResultStatuses(args.events);
  const subagentEnds = new Map<string, SubagentEndedEvent>();
  const subagentsByToolCallId = new Map<
    string,
    ConversationSubagentActivityReport[]
  >();
  const orphanSubagents: ConversationSubagentActivityReport[] = [];

  for (const event of args.events) {
    if (event.data.type === "subagent_ended") {
      subagentEnds.set(
        event.data.subagentInvocationId,
        event as SubagentEndedEvent,
      );
    }
  }

  for (const event of args.events) {
    if (event.data.type !== "subagent_started") {
      continue;
    }
    const start = event as SubagentStartedEvent;
    const parentStatus = start.data.parentToolCallId
      ? toolStatuses.get(start.data.parentToolCallId)
      : undefined;
    const activity = subagentActivityFromEvents(
      start,
      subagentEnds.get(start.data.subagentInvocationId),
      { canExposeTranscript: args.canExposePayload, parentStatus },
    );
    if (start.data.parentToolCallId) {
      subagentsByToolCallId.set(start.data.parentToolCallId, [
        ...(subagentsByToolCallId.get(start.data.parentToolCallId) ?? []),
        activity,
      ]);
      continue;
    }
    orphanSubagents.push(activity);
  }

  const rows: ConversationActivityReport[] = [];
  for (const event of args.events) {
    if (event.data.type !== "tool_execution_started") {
      continue;
    }
    rows.push({
      type: "tool_execution",
      id: event.data.toolCallId,
      toolCallId: event.data.toolCallId,
      toolName: event.data.toolName,
      createdAt: new Date(event.createdAtMs).toISOString(),
      status: toolStatuses.get(event.data.toolCallId) ?? "running",
      subagents: subagentsByToolCallId.get(event.data.toolCallId) ?? [],
      ...activityPayloadFields(event.data.args, args.canExposePayload),
    });
  }

  return [...rows, ...orphanSubagents].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export type SubagentStartedEvent = ConversationEvent & {
  data: Extract<ConversationEventData, { type: "subagent_started" }>;
};
export type SubagentEndedEvent = ConversationEvent & {
  data: Extract<ConversationEventData, { type: "subagent_ended" }>;
};

/** Pair durable subagent start and end events into one activity report. */
export function subagentActivityFromEvents(
  start: SubagentStartedEvent,
  end: SubagentEndedEvent | undefined,
  options: {
    canExposeTranscript?: boolean;
    parentStatus?: ConversationActivityStatus;
  } = {},
): ConversationSubagentActivityReport {
  return {
    type: "subagent",
    id: start.data.subagentInvocationId,
    subagentKind: start.data.subagentKind,
    ...(start.data.modelId ? { modelId: start.data.modelId } : {}),
    ...(start.data.parentToolCallId
      ? { parentToolCallId: start.data.parentToolCallId }
      : {}),
    ...(start.data.reasoningLevel
      ? { reasoningLevel: start.data.reasoningLevel }
      : {}),
    createdAt: new Date(start.createdAtMs).toISOString(),
    ...(end
      ? {
          endedAt: new Date(end.createdAtMs).toISOString(),
          outcome: end.data.outcome,
          status: end.data.outcome,
          // Every subagent is a child conversation whose transcript loads on
          // demand; expose the affordance only when the parent is public.
          ...(options.canExposeTranscript ? { transcriptAvailable: true } : {}),
        }
      : { status: options.parentStatus ?? "running" }),
  };
}

/**
 * Read one child-agent transcript through its parent conversation.
 *
 * The parent records `subagent_started`/`subagent_ended` as durable events that
 * name the child by `childConversationId`; the transcript is the child
 * conversation's own projected Pi messages. `runId` is retained for the route
 * signature but no longer scopes the lookup — subagent events live on the parent
 * conversation regardless of the run that produced them.
 */
