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

export interface ActorIdentity {
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
  actorIdentity?: ActorIdentity;
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

export interface ActorActivityDayReport {
  active: number;
  conversations: number;
  date: string;
  durationMs: number;
  failed: number;
  hung: number;
  runs: number;
  tokens?: number;
}

export interface ActorTotalsReport {
  active: number;
  activeDays: number;
  conversations: number;
  durationMs: number;
  failed: number;
  hung: number;
  runs: number;
  tokens?: number;
}

export interface ActorSummaryReport extends ActorTotalsReport {
  firstSeenAt: string;
  lastSeenAt: string;
  actor: ActorIdentity & { email: string };
}

export interface ActorDirectoryReport {
  generatedAt: string;
  people: ActorSummaryReport[];
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  truncated: boolean;
}

export interface ActorProfileReport {
  activityDays: ActorActivityDayReport[];
  generatedAt: string;
  locations: ConversationStatsItem[];
  recentConversations: ConversationSummaryReport[];
  actor: ActorIdentity & { email: string };
  sampleLimit: number;
  sampleSize: number;
  source: "conversation_index";
  surfaces: ConversationStatsItem[];
  totals: ActorTotalsReport;
  truncated: boolean;
  windowEnd: string;
  windowStart: string;
}
