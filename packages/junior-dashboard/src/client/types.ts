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
import type {
  ConversationActivityStatus,
  ConversationContextEvent,
  ConversationDetailReport,
  TranscriptMessage,
  TranscriptPart,
} from "@sentry/junior/api/schema";
import type { DashboardConfig, DashboardIdentity } from "../api/schema";

// Dashboard view transcript parts merge reporting transcript payloads with
// lifecycle activity rows; the backend reporting transcript contract is unchanged.
type TranscriptViewReportingPart = TranscriptPart & {
  endedAt?: never;
  outcome?: never;
  parentToolCallId?: never;
  status?: ConversationActivityStatus;
  subagentKind?: never;
};

export type TranscriptViewToolCallPart = TranscriptViewReportingPart & {
  type: "tool_call";
};

export type TranscriptViewSubagentPart = {
  bytes?: never;
  chars?: never;
  endedAt?: string;
  id: string;
  input?: never;
  inputKeys?: never;
  inputSizeBytes?: never;
  inputSizeChars?: never;
  inputType?: never;
  modelId?: string;
  name?: never;
  outcome?: "success" | "error" | "aborted";
  output?: never;
  outputKeys?: never;
  outputSizeBytes?: never;
  outputSizeChars?: never;
  outputType?: never;
  parentToolCallId?: string;
  reasoningLevel?: string;
  redacted?: boolean;
  status: ConversationActivityStatus;
  subagentKind: string;
  transcriptAvailable?: boolean;
  text?: never;
  type: "subagent";
};

export type TranscriptViewContextEventPart = {
  bytes?: never;
  chars?: never;
  endedAt?: never;
  event: ConversationContextEvent;
  id?: never;
  input?: never;
  inputKeys?: never;
  inputSizeBytes?: never;
  inputSizeChars?: never;
  inputType?: never;
  modelId?: never;
  name?: never;
  outcome?: never;
  output?: never;
  outputKeys?: never;
  outputSizeBytes?: never;
  outputSizeChars?: never;
  outputType?: never;
  parentToolCallId?: never;
  reasoningLevel?: never;
  redacted?: never;
  status?: never;
  subagentKind?: never;
  text?: never;
  transcriptAvailable?: never;
  type: "context_event";
};

export type TranscriptViewPart =
  | TranscriptViewReportingPart
  | TranscriptViewContextEventPart
  | TranscriptViewSubagentPart
  | TranscriptViewToolCallPart;

export type TranscriptViewMessage = Omit<TranscriptMessage, "parts"> & {
  parts: TranscriptViewPart[];
};

export type ConversationTranscript = Omit<
  ConversationDetailReport,
  "generatedAt" | "sentryConversationUrl"
> & {
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
