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

export type TranscriptViewTextPart =
  | { redacted?: never; text: string; type: "text" }
  | { redacted: true; text?: never; type: "text" };

export type TranscriptViewToolCallPart = {
  id: string;
  input?: unknown;
  name: string;
  output?: unknown;
  resultTimestamp?: number;
  status: "completed" | "error" | "running";
  type: "tool_call";
};

export type TranscriptViewSubagentPart = {
  childConversationId: string;
  id: string;
  status: "aborted" | "completed" | "error" | "running";
  subagentKind: string;
  type: "subagent";
};

export type TranscriptViewContextEventPart = {
  event:
    | { createdAt: string; type: "compaction" }
    | {
        createdAt: string;
        modelId: string;
        modelProfile: string;
        reasoningLevel?: string;
        type: "handoff";
      };
  type: "context_event";
};

export type TranscriptViewPart =
  | TranscriptViewContextEventPart
  | TranscriptViewSubagentPart
  | TranscriptViewTextPart
  | TranscriptViewToolCallPart;

export type TranscriptViewMessage = {
  eventType?: string;
  route?: {
    confidence?: number;
    modelId: string;
    modelProfile: string;
    reasoningLevel: string;
    source: "configured" | "inherited" | "router";
  };
  outcome?: "error" | "delivery_failed";
  parts: TranscriptViewPart[];
  role: "assistant" | "system" | "tool" | "user";
  sourceSeq: number;
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
