import type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
} from "@sentry/junior-plugin-api";

export type {
  PluginConversationStatus,
  PluginConversations,
  PluginConversationSummary,
};

export type ConversationReportStatus =
  | "active"
  | "completed"
  | "failed"
  | "hung"
  | "superseded";

export type ConversationSurface = "api" | "internal" | "scheduler" | "slack";

/** Estimated USD cost breakdown for a conversation run. */
export interface ConversationCost {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

/** Token and estimated USD cost usage for a conversation run. */
export interface ConversationUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: ConversationCost;
}

export interface ActorIdentity {
  email?: string;
  fullName?: string;
  slackUserId?: string;
  slackUserName?: string;
}

export interface ConversationSummaryReport {
  /** Always-populated display title, with privacy redaction applied first. */
  displayTitle: string;
  cumulativeDurationMs: number;
  cumulativeUsage?: ConversationUsage;
  conversationId: string;
  id: string;
  status: ConversationReportStatus;
  startedAt: string;
  lastSeenAt: string;
  lastProgressAt: string;
  completedAt?: string;
  surface: ConversationSurface;
  actorIdentity?: ActorIdentity;
  channel?: string;
  channelName?: string;
  channelNameRedacted?: boolean;
  sentryTraceUrl?: string;
  traceId?: string;
}

export type TranscriptPartType =
  | "text"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "unknown";

export interface TranscriptPart {
  bytes?: number;
  chars?: number;
  id?: string;
  input?: unknown;
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
  name?: string;
  output?: unknown;
  outputKeys?: string[];
  outputSizeBytes?: number;
  outputSizeChars?: number;
  outputType?: string;
  redacted?: boolean;
  sourceType?: string;
  text?: string;
  type: TranscriptPartType;
}

export type TranscriptRole =
  | "assistant"
  | "system"
  | "tool"
  | "toolResult"
  | "unknown"
  | "user";

export interface TranscriptMessage {
  parts: TranscriptPart[];
  role: TranscriptRole;
  timestamp?: number;
}

export interface ConversationRunReport extends ConversationSummaryReport {
  activity?: ConversationActivityReport[];
  modelId?: string;
  reasoningLevel?: string;
  transcriptAvailable: boolean;
  transcriptMetadata?: TranscriptMessage[];
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  /**
   * True when retention purged this conversation's content. Expiry under
   * retention is distinct from privacy redaction: the content aged out and was
   * deleted, so no metadata is derived from it (see data-redaction-policy.md).
   */
  transcriptExpired?: boolean;
  /** When the content was purged (ISO 8601); present only with `transcriptExpired`. */
  transcriptExpiredAt?: string;
  transcript: TranscriptMessage[];
}

export type ConversationActivityStatus =
  | "aborted"
  | "completed"
  | "error"
  | "running"
  | "success";

export interface ConversationSubagentActivityReport {
  type: "subagent";
  createdAt: string;
  endedAt?: string;
  id: string;
  modelId?: string;
  outcome?: "success" | "error" | "aborted";
  parentToolCallId?: string;
  reasoningLevel?: string;
  status: ConversationActivityStatus;
  subagentKind: string;
  transcriptAvailable?: boolean;
}

export interface ConversationToolActivityReport {
  type: "tool_execution";
  args?: unknown;
  createdAt: string;
  id: string;
  inputKeys?: string[];
  inputSizeBytes?: number;
  inputSizeChars?: number;
  inputType?: string;
  redacted?: boolean;
  status: ConversationActivityStatus;
  subagents: ConversationSubagentActivityReport[];
  toolCallId: string;
  toolName: string;
}

export type ConversationActivityReport =
  | ConversationToolActivityReport
  | ConversationSubagentActivityReport;

export interface ConversationReport {
  conversationId: string;
  /** Always-populated display title, computed the same way as per-run reports. */
  displayTitle: string;
  generatedAt: string;
  sentryConversationUrl?: string;
  runs: ConversationRunReport[];
}

export interface ConversationSubagentTranscriptReport {
  type: "subagent";
  createdAt: string;
  endedAt?: string;
  id: string;
  modelId?: string;
  outcome?: "success" | "error" | "aborted";
  parentToolCallId?: string;
  reasoningLevel?: string;
  status: ConversationActivityStatus;
  subagentConversationId?: string;
  subagentKind: string;
  subagentSentryConversationUrl?: string;
  transcript: TranscriptMessage[];
  transcriptAvailable: boolean;
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
  /** True when retention purged the parent conversation's content. */
  transcriptExpired?: boolean;
  /** When the content was purged (ISO 8601); present only with `transcriptExpired`. */
  transcriptExpiredAt?: string;
  unavailableReason?:
    | "missing_transcript_range"
    | "missing_transcript_ref"
    | "not_found";
}

export interface ConversationFeed {
  conversations: ConversationSummaryReport[];
  source: "conversation_index";
  generatedAt: string;
}

export interface ConversationStatsItem {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  hung: number;
  label: string;
  runs: number;
  costUsd?: number;
  tokens?: number;
}

export interface ConversationStatsReport {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  generatedAt: string;
  hung: number;
  locations: ConversationStatsItem[];
  actors: ConversationStatsItem[];
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  costUsd?: number;
  tokens?: number;
  truncated: boolean;
  runs: number;
  windowEnd: string;
  windowStart: string;
}
