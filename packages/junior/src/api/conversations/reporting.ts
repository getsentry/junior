import type { juniorConversations, juniorDestinations } from "@/db/schema";
import type {
  ActorIdentity,
  ConversationReportStatus,
  ConversationSummaryReport,
  ConversationSurface,
} from "./schema";

const PRIVATE_CONVERSATION_LABEL = "Private Conversation";

export type ReportingConversationRow = {
  channelName: string | null;
  conversationId: string;
  createdAt: Date;
  destinationId: string | null;
  destinationVisibility:
    | (typeof juniorDestinations.$inferSelect)["visibility"]
    | null;
  durationMs: number;
  email: string | null;
  executionStatus: (typeof juniorConversations.$inferSelect)["executionStatus"];
  executionUpdatedAt: Date | null;
  fullName: string | null;
  handle: string | null;
  lastActivityAt: Date;
  providerSubjectId: string | null;
  source: (typeof juniorConversations.$inferSelect)["source"];
  title: string | null;
  updatedAt: Date;
  usage: (typeof juniorConversations.$inferSelect)["usage"];
};

/** Parse report timestamps without throwing on malformed legacy values. */
export function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Convert a report timestamp into the UTC day used by activity projections. */
export function reportDate(value: string): string | undefined {
  const time = reportTime(value);
  return time === undefined
    ? undefined
    : new Date(time).toISOString().slice(0, 10);
}

function channelFromConversationId(conversationId: string): string | undefined {
  const [provider, channel] = conversationId.split(":");
  return provider === "slack" && channel ? channel : undefined;
}

function surfaceFromRow(row: ReportingConversationRow): ConversationSurface {
  if (
    row.source === "api" ||
    row.source === "scheduler" ||
    row.source === "slack"
  ) {
    return row.source;
  }
  if (row.conversationId.startsWith("slack:")) return "slack";
  if (row.conversationId.startsWith("scheduler:")) return "scheduler";
  if (row.conversationId.startsWith("api:")) return "api";
  return "internal";
}

function statusFromRow(
  row: ReportingConversationRow,
): ConversationReportStatus {
  if (row.executionStatus === "failed") return "failed";
  if (row.executionStatus === "idle") return "completed";
  return "active";
}

/** Return the dashboard label for a conversation surface. */
export function surfaceLabel(surface: ConversationSurface): string {
  if (surface === "scheduler") return "Scheduler";
  if (surface === "api") return "API";
  if (surface === "internal") return "Internal";
  return "Conversation";
}

/** Return the dashboard-safe Slack location label for a conversation. */
export function slackLocationLabel(args: {
  channel?: string;
  channelName?: string;
  channelNameRedacted?: boolean;
}): string | undefined {
  const channelId = args.channel;
  if (!channelId) return undefined;
  if (args.channelNameRedacted && args.channelName) return args.channelName;
  const name = args.channelName?.replace(/^#/, "");
  if (channelId.startsWith("D")) return "Direct Message";
  if (channelId.startsWith("C")) {
    return name ? `#${name}` : "Public Channel";
  }
  if (channelId.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return "Group DM";
    return "Private Channel";
  }
  return name || channelId;
}

function channelNameFromRow(row: ReportingConversationRow): string | undefined {
  if (row.destinationVisibility !== "public") {
    return PRIVATE_CONVERSATION_LABEL;
  }
  return row.channelName ?? undefined;
}

function titleFromRow(
  row: ReportingConversationRow,
  surface: ConversationSurface,
): string {
  if (row.destinationVisibility !== "public") {
    return PRIVATE_CONVERSATION_LABEL;
  }
  const channel = channelFromConversationId(row.conversationId);
  return (
    row.title ??
    slackLocationLabel({
      channel,
      channelName: row.channelName ?? undefined,
    }) ??
    surfaceLabel(surface)
  );
}

function actorFromRow(
  row: ReportingConversationRow,
): ActorIdentity | undefined {
  const actor = {
    ...(row.email ? { email: row.email } : {}),
    ...(row.fullName ? { fullName: row.fullName } : {}),
    ...(row.providerSubjectId ? { slackUserId: row.providerSubjectId } : {}),
    ...(row.handle ? { slackUserName: row.handle } : {}),
  };
  return Object.keys(actor).length ? actor : undefined;
}

/** Project one SQL conversation row into a privacy-safe API summary. */
export function summaryFromRow(
  row: ReportingConversationRow,
): ConversationSummaryReport {
  const surface = surfaceFromRow(row);
  const channel = channelFromConversationId(row.conversationId);
  const channelName = channelNameFromRow(row);
  const channelNameRedacted = row.destinationVisibility !== "public";
  const actorIdentity = actorFromRow(row);
  return {
    conversationId: row.conversationId,
    cumulativeDurationMs: row.durationMs,
    displayTitle: titleFromRow(row, surface),
    lastProgressAt: new Date(
      row.executionUpdatedAt ?? row.updatedAt,
    ).toISOString(),
    lastSeenAt: row.lastActivityAt.toISOString(),
    startedAt: row.createdAt.toISOString(),
    status: statusFromRow(row),
    surface,
    ...(actorIdentity ? { actorIdentity } : {}),
    ...(channel ? { channel } : {}),
    ...(channelName ? { channelName } : {}),
    ...(channelNameRedacted ? { channelNameRedacted: true } : {}),
    ...(row.destinationVisibility === "public" && row.destinationId
      ? { locationId: row.destinationId }
      : {}),
  };
}

/** Collapse persisted conversation usage into the dashboard token total. */
export function usageTokens(
  row: Pick<ReportingConversationRow, "usage">,
): number | undefined {
  const usage = row.usage;
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

/** Collapse a conversation summary status into aggregate counters. */
export function conversationSignals(summary: ConversationSummaryReport) {
  return {
    active: summary.status === "active",
    failed: summary.status === "failed",
  };
}
