export type PeopleConversationStatus =
  | "active"
  | "completed"
  | "failed"
  | "hung";
export type PeopleConversationSurface =
  | "api"
  | "internal"
  | "scheduler"
  | "slack";

export interface RequesterIdentity {
  email?: string;
  fullName?: string;
  slackUserId?: string;
  slackUserName?: string;
}

export interface ConversationSummaryReport {
  cumulativeDurationMs: number;
  conversationId: string;
  displayTitle: string;
  id: string;
  lastProgressAt: string;
  lastSeenAt: string;
  startedAt: string;
  status: PeopleConversationStatus;
  surface: PeopleConversationSurface;
  channel?: string;
  channelName?: string;
  channelNameRedacted?: boolean;
  requesterIdentity?: RequesterIdentity;
}

export interface ConversationStatsItem {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  hung: number;
  label: string;
  runs: number;
  tokens?: number;
}

export interface RequesterActivityDayReport {
  active: number;
  conversations: number;
  date: string;
  durationMs: number;
  failed: number;
  hung: number;
  runs: number;
  tokens?: number;
}

export interface RequesterTotalsReport {
  active: number;
  activeDays: number;
  conversations: number;
  durationMs: number;
  failed: number;
  hung: number;
  runs: number;
  tokens?: number;
}

export interface RequesterSummaryReport extends RequesterTotalsReport {
  firstSeenAt: string;
  lastSeenAt: string;
  requester: RequesterIdentity & { email: string };
}

export interface RequesterDirectoryReport {
  generatedAt: string;
  people: RequesterSummaryReport[];
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  truncated: boolean;
}

export interface RequesterProfileReport {
  activityDays: RequesterActivityDayReport[];
  generatedAt: string;
  locations: ConversationStatsItem[];
  recentConversations: ConversationSummaryReport[];
  requester: RequesterIdentity & { email: string };
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  surfaces: ConversationStatsItem[];
  totals: RequesterTotalsReport;
  truncated: boolean;
  windowEnd: string;
  windowStart: string;
}
