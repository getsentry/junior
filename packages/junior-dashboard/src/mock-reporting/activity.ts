import type {
  ConversationActivityStatus,
  ConversationSubagentActivityReport,
  ConversationToolActivityReport,
} from "@sentry/junior/reporting";

import { mockIso } from "./time";

export type MockSubagentActivityOptions = {
  createdAt?: string;
  endedAt?: string;
  id?: string;
  outcome?: "success" | "error" | "aborted";
  parentToolCallId?: string;
  status?: ConversationActivityStatus;
  subagentKind?: string;
  transcriptAvailable?: boolean;
};

/** Build a subagent activity record constrained to the reporting API shape. */
export function mockSubagentActivity(
  options: MockSubagentActivityOptions = {},
): ConversationSubagentActivityReport {
  return {
    type: "subagent",
    createdAt: options.createdAt ?? mockIso(),
    id: options.id ?? "mock-subagent",
    status: options.status ?? "running",
    subagentKind: options.subagentKind ?? "advisor",
    ...(options.endedAt !== undefined ? { endedAt: options.endedAt } : {}),
    ...(options.outcome !== undefined ? { outcome: options.outcome } : {}),
    ...(options.parentToolCallId !== undefined
      ? { parentToolCallId: options.parentToolCallId }
      : {}),
    ...(options.transcriptAvailable !== undefined
      ? { transcriptAvailable: options.transcriptAvailable }
      : {}),
  } satisfies ConversationSubagentActivityReport;
}

export type MockToolActivityOptions = {
  args?: unknown;
  createdAt?: string;
  id?: string;
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
  redacted?: boolean;
  status?: ConversationActivityStatus;
  subagents?: ConversationSubagentActivityReport[];
  toolCallId?: string;
  toolName?: string;
};

/** Build a tool activity record constrained to the reporting API shape. */
export function mockToolActivity(
  options: MockToolActivityOptions = {},
): ConversationToolActivityReport {
  const toolCallId = options.toolCallId ?? "toolu_mock_activity";
  return {
    type: "tool_execution",
    createdAt: options.createdAt ?? mockIso(),
    id: options.id ?? toolCallId,
    status: options.status ?? "running",
    subagents: options.subagents ?? [],
    toolCallId,
    toolName: options.toolName ?? "mock.tool",
    ...(options.args !== undefined ? { args: options.args } : {}),
    ...(options.inputKeys !== undefined
      ? { inputKeys: options.inputKeys }
      : {}),
    ...(options.inputSizeBytes !== undefined
      ? { inputSizeBytes: options.inputSizeBytes }
      : {}),
    ...(options.inputSizeChars !== undefined
      ? { inputSizeChars: options.inputSizeChars }
      : {}),
    ...(options.inputType !== undefined
      ? { inputType: options.inputType }
      : {}),
    ...(options.redacted !== undefined ? { redacted: options.redacted } : {}),
  } satisfies ConversationToolActivityReport;
}
