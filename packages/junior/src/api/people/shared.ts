import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type {
  ConversationStatsItem,
  ConversationSummaryReport,
  ActorActivityDayReport,
  ActorIdentity,
  ActorTotalsReport,
} from "./schema";
import type {
  ConversationReportStatus,
  ConversationSurface,
} from "../conversations/schema";

const PRIVATE_CONVERSATION_LABEL = "Private Conversation";
export const SAMPLE_LIMIT = 5_000;
export const RECENT_LIMIT = 25;
export const ACTIVITY_DAYS = 366;

type Source =
  | "api"
  | "internal"
  | "local"
  | "plugin"
  | "resource_event"
  | "scheduler"
  | "slack";

/** Normalize emails before matching people API rows. */
export function normalizeEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

/** Parse report timestamps without throwing on malformed legacy values. */
export function reportTime(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}

/** Convert a report timestamp into the UTC day used for people activity. */
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

function surfaceFromRow(row: PeopleConversationRow): ConversationSurface {
  const source = row.source as Source | null;
  if (source === "api" || source === "scheduler" || source === "slack") {
    return source;
  }
  if (row.conversationId.startsWith("slack:")) return "slack";
  if (row.conversationId.startsWith("scheduler:")) return "scheduler";
  if (row.conversationId.startsWith("api:")) return "api";
  return "internal";
}

function statusFromRow(row: PeopleConversationRow): ConversationReportStatus {
  if (row.executionStatus === "failed") {
    return "failed";
  }
  if (row.executionStatus === "idle") {
    return "completed";
  }
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
  if (args.channelNameRedacted && args.channelName) {
    return args.channelName;
  }

  const name = args.channelName?.replace(/^#/, "");
  if (channelId.startsWith("D")) return "Direct Message";
  if (channelId.startsWith("C")) return name ? `#${name}` : "Public Channel";
  if (channelId.startsWith("G")) {
    if (name?.startsWith("mpdm-")) return "Group DM";
    return "Private Channel";
  }
  return name || channelId;
}

function channelNameFromRow(row: PeopleConversationRow): string | undefined {
  if (row.destinationVisibility && row.destinationVisibility !== "public") {
    return PRIVATE_CONVERSATION_LABEL;
  }
  return row.channelName ?? undefined;
}

function titleFromRow(
  row: PeopleConversationRow,
  surface: ConversationSurface,
): string {
  if (row.destinationVisibility && row.destinationVisibility !== "public") {
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

/** Project one SQL conversation row into the people API conversation summary. */
export function summaryFromRow(
  row: PeopleConversationRow,
): ConversationSummaryReport {
  const surface = surfaceFromRow(row);
  const channel = channelFromConversationId(row.conversationId);
  const channelName = channelNameFromRow(row);
  const channelNameRedacted =
    Boolean(row.destinationVisibility) &&
    row.destinationVisibility !== "public";
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
    actorIdentity: {
      email: row.email,
      ...(row.fullName ? { fullName: row.fullName } : {}),
      slackUserId: row.providerSubjectId,
      ...(row.handle ? { slackUserName: row.handle } : {}),
    },
    ...(channel ? { channel } : {}),
    ...(channelName ? { channelName } : {}),
    ...(channelNameRedacted ? { channelNameRedacted: true } : {}),
  };
}

/** Collapse stored conversation usage into the dashboard token total. */
export function usageTokens(row: PeopleConversationRow): number | undefined {
  const usage = row.usage;
  if (!usage) return undefined;
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  const values = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedInputTokens,
    usage.cacheCreationTokens,
  ].filter((value): value is number => value !== undefined);
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

/** Build a zeroed totals object for people API aggregations. */
export function emptyTotals(): ActorTotalsReport {
  return {
    active: 0,
    activeDays: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
  };
}

/** Build a zeroed labeled stats row for people API aggregations. */
export function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
  };
}

/** Build a zeroed activity day for the people profile window. */
export function emptyActivityDay(date: string): ActorActivityDayReport {
  return {
    active: 0,
    conversations: 0,
    date,
    durationMs: 0,
    failed: 0,
  };
}

/** Collapse a conversation summary status into aggregate counters. */
export function signals(summary: ConversationSummaryReport) {
  return {
    active: summary.status === "active",
    failed: summary.status === "failed",
  };
}

/** Add status counters into a people API aggregate row. */
export function addSignals(
  target: Pick<ActorTotalsReport, "active" | "failed">,
  value: ReturnType<typeof signals>,
): void {
  target.active += value.active ? 1 : 0;
  target.failed += value.failed ? 1 : 0;
}

/** Return only actor identities that can be grouped by normalized email. */
export function identityWithEmail(
  actor: ActorIdentity | undefined,
): (ActorIdentity & { email: string }) | undefined {
  const email = normalizeEmail(actor?.email);
  if (!email) return undefined;
  return {
    email,
    ...(actor?.fullName ? { fullName: actor.fullName } : {}),
    ...(actor?.slackUserId ? { slackUserId: actor.slackUserId } : {}),
    ...(actor?.slackUserName ? { slackUserName: actor.slackUserName } : {}),
  };
}

/** Preserve the first observed person fields while filling missing details. */
export function mergeIdentity(
  current: ActorIdentity & { email: string },
  next: ActorIdentity & { email: string },
): ActorIdentity & { email: string } {
  return {
    email: current.email,
    ...((current.fullName ?? next.fullName)
      ? { fullName: current.fullName ?? next.fullName }
      : {}),
    ...((current.slackUserId ?? next.slackUserId)
      ? { slackUserId: current.slackUserId ?? next.slackUserId }
      : {}),
    ...((current.slackUserName ?? next.slackUserName)
      ? { slackUserName: current.slackUserName ?? next.slackUserName }
      : {}),
  };
}

/** Fill the fixed people profile activity window from sparse day totals. */
export function activityDays(
  days: Map<string, ActorActivityDayReport>,
  nowMs: number,
): ActorActivityDayReport[] {
  const items: ActorActivityDayReport[] = [];
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));

  for (
    const cursor = new Date(start);
    cursor.getTime() <= end.getTime();
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = cursor.toISOString().slice(0, 10);
    items.push(days.get(date) ?? emptyActivityDay(date));
  }
  return items;
}

/** Return deterministic stats rows for people API responses. */
export function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

/** Read verified actor conversation rows directly from the SQL identity model. */
export async function actorRows(email?: string) {
  const normalizedEmail = normalizeEmail(email);
  const rows = await getDb()
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationVisibility: juniorDestinations.visibility,
      durationMs: juniorConversations.durationMs,
      email: juniorUsers.primaryEmailNormalized,
      executionStatus: juniorConversations.executionStatus,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      handle: juniorIdentities.handle,
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: juniorIdentities.providerSubjectId,
      source: juniorConversations.source,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.emailVerified, true),
        sql`${juniorUsers.primaryEmailNormalized} IS NOT NULL`,
        normalizedEmail
          ? eq(juniorUsers.primaryEmailNormalized, normalizedEmail)
          : undefined,
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(SAMPLE_LIMIT + 1);
  return {
    rows: rows.slice(0, SAMPLE_LIMIT),
    truncated: rows.length > SAMPLE_LIMIT,
  };
}

export type PeopleConversationRow = Awaited<
  ReturnType<typeof actorRows>
>["rows"][number];
