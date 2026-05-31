import type { BundledLanguage } from "shiki/bundle/web";

export type Health = { service: string; status: string; timestamp: string };

export type Runtime = {
  cwd: string;
  descriptionText?: string;
  homeDir: string;
  packagedContent: { packageNames: string[] };
};

export type Plugin = { name: string };

export type Skill = { name: string; pluginProvider?: string };

export type RequesterIdentity = {
  email?: string;
  fullName?: string;
  slackUserId?: string;
  slackUserName?: string;
};

export type TurnUsage = {
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type Session = {
  channel?: string;
  channelName?: string;
  conversationId?: string;
  conversationTitle?: string;
  cumulativeDurationMs?: number;
  cumulativeUsage?: TurnUsage;
  id: string;
  lastProgressAt?: string;
  lastSeenAt?: string;
  requester?: string;
  requesterIdentity?: RequesterIdentity;
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  startedAt?: string;
  status: string;
  surface?: string;
  title?: string;
  traceId?: string;
};

export type TranscriptPart = {
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
  text?: string;
  type: string;
};

export type TranscriptMessage = {
  parts: TranscriptPart[];
  role: string;
  timestamp?: number;
};

export type ConversationTurn = Session & {
  transcript: TranscriptMessage[];
  transcriptAvailable: boolean;
  transcriptMetadata?: TranscriptMessage[];
  transcriptMessageCount?: number;
  transcriptRedacted?: boolean;
  transcriptRedactionReason?: "non_public_conversation";
};

export type ConversationDetailFeed = {
  conversationId: string;
  generatedAt: string;
  turns: ConversationTurn[];
};

export type Conversation = {
  channel?: string;
  channelName?: string;
  conversationTitle?: string;
  id: string;
  lastProgressAt?: string;
  lastSeenAt?: string;
  requester?: string;
  requesterIdentity?: RequesterIdentity;
  sentryConversationUrl?: string;
  sentryTraceUrl?: string;
  startedAt?: string;
  status: Session["status"];
  surface?: string;
  title: string;
  traceId?: string;
  turns: Session[];
};

export type SessionFeed = {
  generatedAt?: string;
  sessions: Session[];
  source: string;
};

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

export type CodeBlock = { code: string; language: BundledLanguage };

export type MarkupNode =
  | {
      type: "element";
      attributes: Array<[string, string]>;
      children: MarkupNode[];
      tagName: string;
    }
  | { type: "text"; text: string };
