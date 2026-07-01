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

function isToolResult(part: TranscriptViewPart): boolean {
  return part.type === "tool_result";
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
    ...(activity.transcriptAvailable !== undefined
      ? { transcriptAvailable: activity.transcriptAvailable }
      : {}),
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
  const emittedSubagentKeys = new Set<string>();
  const emittedToolCallIds = new Set(usedToolCallIds);
  let order = 0;

  for (const activity of activities) {
    if (!emittedToolCallIds.has(activity.toolCallId)) {
      messages.push({
        message: activityMessage(
          activityTimestamp(activity.createdAt),
          toolCallPart(activity),
        ),
        order: order + 0.1,
      });
      emittedToolCallIds.add(activity.toolCallId);
    }

    for (const subagent of activity.subagents) {
      const key = subagentActivityKey(subagent);
      if (emittedSubagentKeys.has(key)) continue;

      messages.push({
        message: activityMessage(
          activityTimestamp(subagent.createdAt),
          subagentPart(subagent),
        ),
        order: order + 0.2,
      });
      emittedSubagentKeys.add(key);
      order += 1;
    }
    order += 1;
  }

  for (const subagent of orphanSubagents) {
    const key = subagentActivityKey(subagent);
    if (emittedSubagentKeys.has(key)) continue;

    messages.push({
      message: activityMessage(
        activityTimestamp(subagent.createdAt),
        subagentPart(subagent),
      ),
      order: order + 0.2,
    });
    emittedSubagentKeys.add(key);
    order += 1;
  }

  return messages;
}

function subagentActivityKey(activity: SubagentActivity): string {
  return [
    activity.parentToolCallId ?? "",
    activity.id,
    activity.subagentKind,
  ].join("\u0000");
}

function messageTimestamp(message: TranscriptViewMessage): number | undefined {
  return typeof message.timestamp === "number" &&
    Number.isFinite(message.timestamp)
    ? message.timestamp
    : undefined;
}

function findMatchingToolResultIndex(
  messages: TranscriptViewMessage[],
  part: TranscriptViewToolCallPart,
): number | undefined {
  const index = messages.findIndex((message) =>
    message.parts.some(
      (candidate) =>
        isToolResult(candidate) && sameToolInvocation(candidate, part),
    ),
  );
  return index >= 0 ? index : undefined;
}

function findParentToolCallIndex(
  messages: TranscriptViewMessage[],
  parentToolCallId: string,
): number | undefined {
  const index = messages.findIndex((message) =>
    message.parts.some(
      (candidate) => isToolCall(candidate) && candidate.id === parentToolCallId,
    ),
  );
  return index >= 0 ? index : undefined;
}

function isSubagentForParent(
  message: TranscriptViewMessage,
  parentToolCallId: string,
): boolean {
  return message.parts.some(
    (candidate) =>
      candidate.type === "subagent" &&
      candidate.parentToolCallId === parentToolCallId,
  );
}

function subagentInsertionIndex(
  messages: TranscriptViewMessage[],
  parentToolCallId: string,
): number | undefined {
  const parentIndex = findParentToolCallIndex(messages, parentToolCallId);
  if (parentIndex === undefined) return undefined;

  let index = parentIndex + 1;
  while (
    index < messages.length &&
    isSubagentForParent(messages[index]!, parentToolCallId)
  ) {
    index += 1;
  }
  return index;
}

function syntheticInsertionIndex(
  messages: TranscriptViewMessage[],
  message: TranscriptViewMessage,
): number {
  const part = message.parts[0];
  if (part && isToolCall(part)) {
    const resultIndex = findMatchingToolResultIndex(messages, part);
    if (resultIndex !== undefined) return resultIndex;
  }

  if (part?.type === "subagent" && part.parentToolCallId) {
    const index = subagentInsertionIndex(messages, part.parentToolCallId);
    if (index !== undefined) return index;
  }

  const timestamp = messageTimestamp(message);
  if (timestamp === undefined) return messages.length;

  const index = messages.findIndex((candidate) => {
    const candidateTimestamp = messageTimestamp(candidate);
    return candidateTimestamp !== undefined && candidateTimestamp > timestamp;
  });
  return index >= 0 ? index : messages.length;
}

function mergeMessages(
  messages: TranscriptViewMessage[],
  synthetic: IndexedMessage[],
): TranscriptViewMessage[] {
  const merged = [...messages];
  for (const entry of synthetic) {
    merged.splice(
      syntheticInsertionIndex(merged, entry.message),
      0,
      entry.message,
    );
  }
  return merged;
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

  return mergeMessages(
    messages,
    syntheticMessages(activities, orphanSubagents, usedToolCallIds),
  );
}
