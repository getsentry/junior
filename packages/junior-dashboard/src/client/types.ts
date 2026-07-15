import type { BundledLanguage } from "shiki/bundle/web";
import type {
  PluginOperationalReportFeed,
  PluginReport,
  SkillReport,
} from "@sentry/junior/api/schema";
import type {
  ConversationStatsReport,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { DashboardConfig, DashboardIdentity } from "../api/schema";

export type TranscriptViewStatus =
  | "aborted"
  | "completed"
  | "error"
  | "running"
  | "success";

type TranscriptViewReportingPart = {
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
  outcome?: never;
  redacted?: boolean;
  sourceType?: string;
  status?: TranscriptViewStatus;
  subagentKind?: never;
  text?: string;
  type: "text" | "thinking" | "tool_call" | "tool_result" | "unknown";
};

export type TranscriptViewToolCallPart = TranscriptViewReportingPart & {
  type: "tool_call";
};

export type TranscriptViewSubagentPart = {
  bytes?: never;
  chars?: never;
  childConversationId: string;
  id: string;
  input?: never;
  inputKeys?: never;
  inputSizeBytes?: never;
  inputSizeChars?: never;
  inputType?: never;
  name?: never;
  output?: never;
  outputKeys?: never;
  outputSizeBytes?: never;
  outputSizeChars?: never;
  outputType?: never;
  redacted?: boolean;
  status: "aborted" | "completed" | "error" | "running";
  subagentKind: string;
  text?: never;
  type: "subagent";
};

export type TranscriptViewContextEventPart = {
  bytes?: never;
  chars?: never;
  event: {
    createdAt: string;
    type: "context_compacted" | "model_handoff";
  };
  id?: never;
  input?: never;
  inputKeys?: never;
  inputSizeBytes?: never;
  inputSizeChars?: never;
  inputType?: never;
  name?: never;
  outcome?: never;
  output?: never;
  outputKeys?: never;
  outputSizeBytes?: never;
  outputSizeChars?: never;
  outputType?: never;
  redacted?: never;
  status?: never;
  subagentKind?: never;
  text?: never;
  type: "context_event";
};

export type TranscriptViewPart =
  | TranscriptViewReportingPart
  | TranscriptViewContextEventPart
  | TranscriptViewSubagentPart
  | TranscriptViewToolCallPart;

export type TranscriptViewMessage = {
  outcome?: "error" | "aborted" | "delivery_failed";
  parts: TranscriptViewPart[];
  role: "assistant" | "system" | "tool" | "toolResult" | "unknown" | "user";
  timestamp?: number;
};

export type ConversationTranscript = ConversationDetailReport & {
  assistantLabel?: string;
};

export type Conversation = {
  archivedAt?: string;
  channel?: string;
  channelName?: string;
  channelNameRedacted?: boolean;
  cumulativeDurationMs: number;
  cumulativeUsage?: ConversationSummaryReport["cumulativeUsage"];
  displayTitle: string;
  id: string;
  lastProgressAt: string;
  lastSeenAt: string;
  locationId?: string;
  actorIdentity?: ConversationSummaryReport["actorIdentity"];
  sentryTraceUrl?: string;
  startedAt: string;
  status: ConversationSummaryReport["status"];
  surface: ConversationSummaryReport["surface"];
  traceId?: string;
};

export type Identity = DashboardIdentity;
export type { DashboardConfig };

export type DashboardCoreData = {
  config: DashboardConfig;
  me: Identity;
};

export type SystemData = DashboardCoreData & {
  conversationStats?: ConversationStatsReport;
  conversationStatsError: boolean;
  conversationStatsLoading: boolean;
  pluginReportsError: boolean;
  pluginReports?: PluginOperationalReportFeed;
  pluginReportsLoading: boolean;
  plugins: PluginReport[];
  skills: SkillReport[];
};

export type VisualStatus = "active" | "failed" | "idle";

export type CodeBlock = {
  code: string;
  fenced?: boolean;
  language: BundledLanguage;
};

export type MarkupNode =
  | {
      type: "element";
      attributes: Array<[string, string]>;
      children: MarkupNode[];
      tagName: string;
    }
  | { type: "text"; text: string };
