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

export type Session = ConversationSummaryReport;

export type TranscriptPart =
  ConversationRunReport["transcript"][number]["parts"][number];

export type TranscriptMessage = ConversationRunReport["transcript"][number];

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
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  startedAt: string;
  status: Session["status"];
  surface: Session["surface"];
  traceId?: string;
  runs: Session[];
};

export type SessionFeed = ReportingConversationFeed;

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
  sessions: SessionFeed;
  skills: Skill[];
};

export type SessionFilter = "active" | "recent" | "hung" | "failed" | "all";

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
