import type {
  AgentStepEntry,
  StoredAgentStep,
} from "@/chat/conversations/history";
import type { PiMessage } from "@/chat/pi/messages";
import { redactedPayloadFields } from "./transcript";
import type {
  ConversationActivityReport,
  ConversationActivityStatus,
  ConversationSubagentActivityReport,
} from "./types";

interface ActivityPayloadMetadata {
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
}
function toolResultStatuses(
  messages: PiMessage[],
): Map<string, ConversationActivityStatus> {
  const statuses = new Map<string, ConversationActivityStatus>();
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
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
 * Build the current-run activity timeline from durable agent steps.
 *
 * Tool executions, subagent starts/ends, and their nesting are derived from the
 * conversation's `junior_agent_steps` rows instead of the legacy Redis session
 * log; tool statuses come from the aligned `pi_message` tool results. Redaction
 * stays byte-compatible with the prior session-log path.
 */
export function buildConversationActivityFromSteps(args: {
  canExposePayload: boolean;
  steps: StoredAgentStep[];
  messages: PiMessage[];
}): ConversationActivityReport[] {
  const toolStatuses = toolResultStatuses(args.messages);
  const subagentEnds = new Map<string, SubagentEndedStep>();
  const subagentsByToolCallId = new Map<
    string,
    ConversationSubagentActivityReport[]
  >();
  const orphanSubagents: ConversationSubagentActivityReport[] = [];

  for (const step of args.steps) {
    if (step.entry.type === "subagent_ended") {
      subagentEnds.set(
        step.entry.subagentInvocationId,
        step as SubagentEndedStep,
      );
    }
  }

  for (const step of args.steps) {
    if (step.entry.type !== "subagent_started") {
      continue;
    }
    const start = step as SubagentStartedStep;
    const parentStatus = start.entry.parentToolCallId
      ? toolStatuses.get(start.entry.parentToolCallId)
      : undefined;
    const activity = subagentActivityFromSteps(
      start,
      subagentEnds.get(start.entry.subagentInvocationId),
      { canExposeTranscript: args.canExposePayload, parentStatus },
    );
    if (start.entry.parentToolCallId) {
      subagentsByToolCallId.set(start.entry.parentToolCallId, [
        ...(subagentsByToolCallId.get(start.entry.parentToolCallId) ?? []),
        activity,
      ]);
      continue;
    }
    orphanSubagents.push(activity);
  }

  const rows: ConversationActivityReport[] = [];
  for (const step of args.steps) {
    if (step.entry.type !== "tool_execution_started") {
      continue;
    }
    rows.push({
      type: "tool_execution",
      id: step.entry.toolCallId,
      toolCallId: step.entry.toolCallId,
      toolName: step.entry.toolName,
      createdAt: new Date(step.createdAtMs).toISOString(),
      status: toolStatuses.get(step.entry.toolCallId) ?? "running",
      subagents: subagentsByToolCallId.get(step.entry.toolCallId) ?? [],
      ...activityPayloadFields(step.entry.args, args.canExposePayload),
    });
  }

  return [...rows, ...orphanSubagents].sort(
    (left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export type SubagentStartedStep = StoredAgentStep & {
  entry: Extract<AgentStepEntry, { type: "subagent_started" }>;
};
export type SubagentEndedStep = StoredAgentStep & {
  entry: Extract<AgentStepEntry, { type: "subagent_ended" }>;
};

/** Pair durable subagent start and end steps into one activity report. */
export function subagentActivityFromSteps(
  start: SubagentStartedStep,
  end: SubagentEndedStep | undefined,
  options: {
    canExposeTranscript?: boolean;
    parentStatus?: ConversationActivityStatus;
  } = {},
): ConversationSubagentActivityReport {
  return {
    type: "subagent",
    id: start.entry.subagentInvocationId,
    subagentKind: start.entry.subagentKind,
    ...(start.entry.modelId ? { modelId: start.entry.modelId } : {}),
    ...(start.entry.parentToolCallId
      ? { parentToolCallId: start.entry.parentToolCallId }
      : {}),
    ...(start.entry.reasoningLevel
      ? { reasoningLevel: start.entry.reasoningLevel }
      : {}),
    createdAt: new Date(start.createdAtMs).toISOString(),
    ...(end
      ? {
          endedAt: new Date(end.createdAtMs).toISOString(),
          outcome: end.entry.outcome,
          status: end.entry.outcome,
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
 * The parent records `subagent_started`/`subagent_ended` as durable steps that
 * name the child by `childConversationId`; the transcript is the child
 * conversation's own projected Pi messages. `runId` is retained for the route
 * signature but no longer scopes the lookup — subagent steps live on the parent
 * conversation regardless of the run that produced them.
 */
