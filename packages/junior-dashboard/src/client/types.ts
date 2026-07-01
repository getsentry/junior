import type { BundledLanguage } from "shiki/bundle/web";
import type {
  ConversationStatsItem as ReportingConversationStatsItem,
  ConversationStatsReport as ReportingConversationStatsReport,
  ConversationReport as ReportingConversationReport,
  PluginOperationalReportFeed,
  PluginOperationalReport,
  RequesterIdentity as ReportingRequesterIdentity,
  ConversationFeed as ReportingConversationFeed,
  ConversationSummaryReport,
  ConversationRunReport,
  ConversationUsage,
  HealthReport,
  PluginReport as RuntimePluginReport,
  RuntimeInfoReport,
  SkillReport,
} from "@sentry/junior/reporting";

export type Health = HealthReport;

export type Runtime = RuntimeInfoReport;

export type Plugin = RuntimePluginReport;

export type Skill = SkillReport;

export type PluginReport = PluginOperationalReport;

export type PluginReportFeed = PluginOperationalReportFeed;

export type ConversationStatsReport = ReportingConversationStatsReport;

export type ConversationStatsItem = ReportingConversationStatsItem;

export type RequesterIdentity = ReportingRequesterIdentity;

export type TurnUsage = ConversationUsage;

export type ConversationSummary = ConversationSummaryReport;

export type TranscriptPart =
  ConversationRunReport["transcript"][number]["parts"][number];

export type TranscriptMessage = ConversationRunReport["transcript"][number];

export type ConversationActivity = NonNullable<
  ConversationRunReport["activity"]
>[number];

export type TranscriptActivityStatus = NonNullable<
  ConversationRunReport["activity"]
>[number]["status"];

// Dashboard view transcript parts merge reporting transcript payloads with
// lifecycle activity rows; the backend reporting transcript contract is unchanged.
type TranscriptViewReportingPart = TranscriptPart & {
  endedAt?: never;
  outcome?: never;
  parentToolCallId?: never;
  status?: TranscriptActivityStatus;
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
  name?: never;
  outcome?: "success" | "error" | "aborted";
  output?: never;
  outputKeys?: never;
  outputSizeBytes?: never;
  outputSizeChars?: never;
  outputType?: never;
  parentToolCallId?: string;
  redacted?: boolean;
  status: TranscriptActivityStatus;
  subagentKind: string;
  text?: never;
  type: "subagent";
};

export type TranscriptViewPart =
  | TranscriptViewReportingPart
  | TranscriptViewSubagentPart
  | TranscriptViewToolCallPart;

export type TranscriptViewMessage = Omit<TranscriptMessage, "parts"> & {
  parts: TranscriptViewPart[];
};

export type ConversationTurn = ConversationRunReport;

export type ConversationDetailFeed = ReportingConversationReport;

export type Conversation = {
  channel?: string;
  channelName?: string;
  displayTitle: string;
  id: string;
  lastProgressAt: string;
  lastSeenAt: string;
  requesterIdentity?: RequesterIdentity;
  sentryTraceUrl?: string;
  startedAt: string;
  status: ConversationSummary["status"];
  surface: ConversationSummary["surface"];
  traceId?: string;
  runs: ConversationSummary[];
};

export type ConversationFeed = ReportingConversationFeed;

export type Identity = { user: { email?: string; hostedDomain?: string } };

export type DashboardConfig = {
  allowedEmailCount: number;
  allowedGoogleDomainCount: number;
  authRequired: boolean;
  authPath: string;
  basePath: string;
  sentryConversationLinks: boolean;
  timeZone: string;
};

export type DashboardData = {
  config: DashboardConfig;
  conversationStats: ConversationStatsReport;
  conversationStatsError: boolean;
  conversationStatsLoading: boolean;
  health: Health;
  me: Identity;
  pluginReportsError: boolean;
  pluginReports: PluginReportFeed;
  pluginReportsLoading: boolean;
  plugins: Plugin[];
  runtime: Runtime;
  conversations: ConversationFeed;
  skills: Skill[];
};

export type ConversationFilter =
  | "active"
  | "recent"
  | "hung"
  | "failed"
  | "all";

export type VisualStatus = "active" | "failed" | "hung" | "idle";

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
