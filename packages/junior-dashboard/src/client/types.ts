import type { BundledLanguage } from "shiki/bundle/web";
import type {
  PluginOperationalReportFeed,
  Plugin,
  SkillReport,
} from "@sentry/junior/api/schema";
import type {
  ActorIdentity,
  ConversationStatsReport,
  ConversationSummaryReport,
} from "@sentry/junior/api/schema";
import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import type { ConversationEventPresentation } from "@sentry/junior-plugin-api";
import type { DashboardConfig, DashboardIdentity } from "../api/schema";

export type TranscriptViewTextPart =
  | { redacted?: never; text: string; type: "text" }
  | { redacted: true; text?: never; type: "text" };

export type TranscriptViewReasoningPart =
  | { redacted?: never; text: string; type: "reasoning" }
  | { redacted: true; text?: never; type: "reasoning" };

export type TranscriptViewToolCallPart = {
  id: string;
  input?: unknown;
  name: string;
  output?: unknown;
  resultTimestamp?: number;
  startedTimestamp?: number;
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
    | {
        createdAt: string;
        type: "compaction";
        modelId?: string;
        modelProfile?: string;
        summary?: string;
        details?: {
          reason: "capacity";
          estimatedInputTokens: number;
          replacementInputTokens?: number;
          triggerTokens: number;
          inputLimitTokens: number;
          inputMessageCount: number;
          retainedMessageCount: number;
          summaryChars: number;
        };
      }
    | {
        createdAt: string;
        modelId: string;
        modelProfile: string;
        reasoningLevel?: string;
        summary?: string;
        type: "handoff";
      };
  type: "context_event";
};

export type TranscriptViewStructuredEventPart = {
  name: string;
  namespace: string;
  presentation: ConversationEventPresentation;
  type: "structured_event";
  version: number;
};

export type TranscriptViewDeliveredAttachment = {
  bytes: number;
  contentType: string;
  filename: string;
  id: string;
};

export type TranscriptViewAttachmentsDeliveredPart = {
  attachments: TranscriptViewDeliveredAttachment[];
  type: "attachments_delivered";
};

export type TranscriptViewPart =
  | TranscriptViewAttachmentsDeliveredPart
  | TranscriptViewContextEventPart
  | TranscriptViewStructuredEventPart
  | TranscriptViewReasoningPart
  | TranscriptViewSubagentPart
  | TranscriptViewTextPart
  | TranscriptViewToolCallPart;

export type TranscriptViewTurnContext = {
  content: Record<string, unknown>;
  kind: string;
  loadedAt: string;
  pluginName: string;
  version: number;
};

export type TranscriptViewMessage = {
  actorIdentity?: ActorIdentity;
  contexts?: TranscriptViewTurnContext[];
  /** Mailbox delivery mode while the message is still pending history commit. */
  delivery?: "defer" | "interrupt";
  eventType?: string;
  /** Whether the source message addressed Junior directly. */
  explicitMention?: boolean;
  /** Whether a non-mention message was used as input to a turn. */
  context?: boolean;
  /** Stable history/message id used to drop pending rows after commit. */
  messageId?: string;
  /** True while the message is accepted in the mailbox but not yet in history. */
  pending?: boolean;
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
  source?: "slack" | "web";
  sourceSeq: number;
  timestamp?: number;
};

export type ConversationTranscript = ConversationDetailReport;

export type Conversation = {
  annotations?: ConversationSummaryReport["annotations"];
  archivedAt?: string;
  auxiliaryCosts?: ConversationSummaryReport["auxiliaryCosts"];
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
  sourceUrl?: string;
  startedAt: string;
  status: ConversationSummaryReport["status"];
  surface: ConversationSummaryReport["surface"];
  traceId?: string;
  isPriority?: boolean;
  unfinishedWork?: boolean;
  unfinishedWorkLabels?: string[];
  visibility?: ConversationSummaryReport["visibility"];
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
  plugins: Plugin[];
  skills: SkillReport[];
};

export type VisualStatus = "active" | "failed" | "idle";

export type CodeBlock = {
  code: string;
  fenced?: boolean;
  language: BundledLanguage;
};
