import type { BundledLanguage } from "shiki/bundle/web";
import type {
  DashboardConversationStatsItem,
  DashboardConversationStatsReport,
  DashboardConversationReport,
  PluginOperationalReportFeed,
  PluginOperationalReport,
  DashboardRequesterIdentity,
  DashboardSessionFeed,
  DashboardSessionReport,
  DashboardTurnReport,
  DashboardTurnUsage,
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

export type ConversationStatsReport = DashboardConversationStatsReport;

export type ConversationStatsItem = DashboardConversationStatsItem;

export type RequesterIdentity = DashboardRequesterIdentity;

export type TurnUsage = DashboardTurnUsage;

export type Session = DashboardSessionReport;

export type TranscriptPart =
  DashboardTurnReport["transcript"][number]["parts"][number];

export type TranscriptMessage = DashboardTurnReport["transcript"][number];

export type ConversationTurn = DashboardTurnReport;

export type ConversationDetailFeed = DashboardConversationReport;

export type Conversation = {
  channel?: string;
  channelName?: string;
  conversationTitle?: string;
  id: string;
  lastProgressAt: string;
  lastSeenAt: string;
  requesterIdentity?: RequesterIdentity;
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  startedAt: string;
  status: Session["status"];
  surface: Session["surface"];
  title: string;
  traceId?: string;
  turns: Session[];
};

export type SessionFeed = DashboardSessionFeed;

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
