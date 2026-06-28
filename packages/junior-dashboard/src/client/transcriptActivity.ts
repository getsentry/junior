import { sameToolInvocation } from "./toolInvocations";
import type {
  ConversationActivity,
  ConversationTurn,
  TranscriptViewMessage,
  TranscriptViewPart,
  TranscriptViewSubagentPart,
  TranscriptViewToolCallPart,
} from "./types";

type ToolActivity = Extract<ConversationActivity, { type: "tool_execution" }>;

type SubagentActivity = Extract<ConversationActivity, { type: "subagent" }>;

type IndexedMessage = {
  message: TranscriptViewMessage;
  order: number;
};

function activityTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isToolCall(
  part: TranscriptViewPart,
): part is TranscriptViewToolCallPart {
  return part.type === "tool_call";
}

function partMatchesToolActivity(
  part: TranscriptViewPart,
  activity: ToolActivity,
): boolean {
  return sameToolInvocation(part, {
    id: activity.toolCallId,
    name: activity.toolName,
  });
}

function toolCallPart(
  activity: ToolActivity,
  existing?: TranscriptViewToolCallPart,
): TranscriptViewPart {
  const input = existing?.input ?? activity.args;
  const part: TranscriptViewPart = {
    type: "tool_call",
    id: activity.toolCallId,
    name: activity.toolName,
    status: activity.status,
  };
  if (activity.redacted) {
    part.redacted = true;
    if (activity.inputKeys) part.inputKeys = activity.inputKeys;
    if (activity.inputSizeBytes !== undefined) {
      part.inputSizeBytes = activity.inputSizeBytes;
    }
    if (activity.inputSizeChars !== undefined) {
      part.inputSizeChars = activity.inputSizeChars;
    }
    if (activity.inputType) part.inputType = activity.inputType;
    return part;
  }
  if (input !== undefined) part.input = input;
  return part;
}

function subagentPart(activity: SubagentActivity): TranscriptViewSubagentPart {
  return {
    type: "subagent",
    id: activity.id,
    subagentKind: activity.subagentKind,
    status: activity.status,
    ...(activity.outcome ? { outcome: activity.outcome } : {}),
    ...(activity.parentToolCallId
      ? { parentToolCallId: activity.parentToolCallId }
      : {}),
    ...(activity.endedAt ? { endedAt: activity.endedAt } : {}),
  };
}

function toolActivities(turn: ConversationTurn): ToolActivity[] {
  return (turn.activity ?? []).filter(
    (activity): activity is ToolActivity => activity.type === "tool_execution",
  );
}

function orphanSubagentActivities(turn: ConversationTurn): SubagentActivity[] {
  return (turn.activity ?? []).filter(
    (activity): activity is SubagentActivity => activity.type === "subagent",
  );
}

function activityMessage(
  timestamp: number | undefined,
  part: TranscriptViewPart,
): TranscriptViewMessage {
  return {
    role: "tool",
    ...(timestamp !== undefined ? { timestamp } : {}),
    parts: [part],
  };
}

function upgradeToolCalls(
  messages: TranscriptViewMessage[],
  activities: ToolActivity[],
): {
  messages: TranscriptViewMessage[];
  usedToolCallIds: Set<string>;
} {
  const usedToolCallIds = new Set<string>();
  if (activities.length === 0) {
    return { messages, usedToolCallIds };
  }

  const upgraded = messages.map((message) => {
    let changed = false;
    const parts = message.parts.map((part) => {
      if (!isToolCall(part)) return part;

      const activity = activities.find(
        (candidate) =>
          !usedToolCallIds.has(candidate.toolCallId) &&
          partMatchesToolActivity(part, candidate),
      );
      if (!activity) return part;

      usedToolCallIds.add(activity.toolCallId);
      changed = true;
      return toolCallPart(activity, part);
    });

    return changed ? { ...message, parts } : message;
  });

  return { messages: upgraded, usedToolCallIds };
}

function syntheticMessages(
  activities: ToolActivity[],
  orphanSubagents: SubagentActivity[],
  usedToolCallIds: Set<string>,
): IndexedMessage[] {
  const messages: IndexedMessage[] = [];
  let order = 0;

  for (const activity of activities) {
    if (!usedToolCallIds.has(activity.toolCallId)) {
      messages.push({
        message: activityMessage(
          activityTimestamp(activity.createdAt),
          toolCallPart(activity),
        ),
        order: order + 0.1,
      });
    }

    for (const subagent of activity.subagents) {
      messages.push({
        message: activityMessage(
          activityTimestamp(subagent.createdAt),
          subagentPart(subagent),
        ),
        order: order + 0.2,
      });
      order += 1;
    }
    order += 1;
  }

  for (const subagent of orphanSubagents) {
    messages.push({
      message: activityMessage(
        activityTimestamp(subagent.createdAt),
        subagentPart(subagent),
      ),
      order: order + 0.2,
    });
    order += 1;
  }

  return messages;
}

function compareIndexedMessages(left: IndexedMessage, right: IndexedMessage) {
  const leftTimestamp = left.message.timestamp;
  const rightTimestamp = right.message.timestamp;
  if (
    typeof leftTimestamp === "number" &&
    Number.isFinite(leftTimestamp) &&
    typeof rightTimestamp === "number" &&
    Number.isFinite(rightTimestamp) &&
    leftTimestamp !== rightTimestamp
  ) {
    return leftTimestamp - rightTimestamp;
  }
  return left.order - right.order;
}

/** Return the transcript rows that dashboard views should render for a turn. */
export function turnTranscriptMessages(
  turn: ConversationTurn,
): TranscriptViewMessage[] {
  const source = turn.transcriptAvailable
    ? turn.transcript
    : (turn.transcriptMetadata ?? []);
  const activities = toolActivities(turn);
  const orphanSubagents = orphanSubagentActivities(turn);
  if (activities.length === 0 && orphanSubagents.length === 0) {
    return source;
  }

  const { messages, usedToolCallIds } = upgradeToolCalls(source, activities);
  const indexedMessages: IndexedMessage[] = messages.map((message, order) => ({
    message,
    order,
  }));

  return [
    ...indexedMessages,
    ...syntheticMessages(activities, orphanSubagents, usedToolCallIds),
  ]
    .sort(compareIndexedMessages)
    .map((entry) => entry.message);
}
