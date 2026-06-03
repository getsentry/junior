import type { BundledLanguage } from "shiki/bundle/web";
import type {
  DashboardConversationReport,
  DashboardRequesterIdentity,
  DashboardSessionFeed,
  DashboardSessionReport,
  DashboardTurnReport,
  DashboardTurnUsage,
  HealthReport,
  PluginReport,
  RuntimeInfoReport,
  SkillReport,
} from "@sentry/junior/reporting";

export type Health = HealthReport;

export type Runtime = RuntimeInfoReport;

export type Plugin = PluginReport;

export type Skill = SkillReport;

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
  health: Health;
  me: Identity;
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
