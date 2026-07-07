import { and, asc, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/chat/sql/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/chat/sql/schema";
import type {
  ConversationStatsItem,
  ConversationSummaryReport,
  PeopleConversationStatus,
  PeopleConversationSurface,
  ActorActivityDayReport,
  ActorIdentity,
  ActorTotalsReport,
} from "./types";

const PRIVATE_CONVERSATION_LABEL = "Private Conversation";
export const SAMPLE_LIMIT = 5_000;
export const RECENT_LIMIT = 25;
export const ACTIVITY_DAYS = 366;
const HUNG_PROGRESS_MS = 5 * 60 * 1000;

type Source =
  | "api"
  | "internal"
  | "local"
  | "plugin"
  | "resource_event"
  | "scheduler"
  | "slack";

export interface PeopleApiQueryOptions {
  db?: JuniorDatabase;
}

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

function surfaceFromRow(row: PeopleConversationRow): PeopleConversationSurface {
  const source = row.source as Source | null;
  if (source === "api" || source === "scheduler" || source === "slack") {
    return source;
  }
  if (row.conversationId.startsWith("slack:")) return "slack";
  if (row.conversationId.startsWith("scheduler:")) return "scheduler";
  if (row.conversationId.startsWith("api:")) return "api";
  return "internal";
}

function statusFromRow(
  row: PeopleConversationRow,
  nowMs: number,
): PeopleConversationStatus {
  if (row.executionStatus === "failed") {
    return "failed";
  }
  if (row.executionStatus === "idle") {
    return "completed";
  }
  const updatedAtMs = (row.executionUpdatedAt ?? row.updatedAt).getTime();
  if (
    row.executionStatus === "running" &&
    nowMs - updatedAtMs > HUNG_PROGRESS_MS
  ) {
    return "hung";
  }
  return "active";
}

/** Return the dashboard label for a conversation surface. */
export function surfaceLabel(surface: PeopleConversationSurface): string {
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
  surface: PeopleConversationSurface,
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
  nowMs: number,
): ConversationSummaryReport {
  const surface = surfaceFromRow(row);
  const channel = channelFromConversationId(row.conversationId);
  const channelName = channelNameFromRow(row);
  const channelNameRedacted =
    Boolean(row.destinationVisibility) &&
    row.destinationVisibility !== "public";
  return {
    conversationId: row.conversationId,
    cumulativeDurationMs: 0,
    displayTitle: titleFromRow(row, surface),
    id: row.runId ?? row.conversationId,
    lastProgressAt: new Date(
      row.executionUpdatedAt ?? row.updatedAt,
    ).toISOString(),
    lastSeenAt: row.lastActivityAt.toISOString(),
    startedAt: row.createdAt.toISOString(),
    status: statusFromRow(row, nowMs),
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

/** Build a zeroed totals object for people API aggregations. */
export function emptyTotals(): ActorTotalsReport {
  return {
    active: 0,
    activeDays: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    hung: 0,
    runs: 0,
  };
}

/** Build a zeroed labeled stats row for people API aggregations. */
export function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    hung: 0,
    label,
    runs: 0,
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
    hung: 0,
    runs: 0,
  };
}

/** Collapse a conversation summary status into aggregate counters. */
export function signals(summary: ConversationSummaryReport) {
  return {
    active: summary.status === "active",
    failed: summary.status === "failed",
    hung: summary.status === "hung",
  };
}

/** Add status counters into a people API aggregate row. */
export function addSignals(
  target: Pick<ActorTotalsReport, "active" | "failed" | "hung">,
  value: ReturnType<typeof signals>,
): void {
  target.active += value.active ? 1 : 0;
  target.failed += value.failed ? 1 : 0;
  target.hung += value.hung ? 1 : 0;
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
      right.runs - left.runs ||
      right.durationMs - left.durationMs ||
      left.label.localeCompare(right.label),
  );
}

/** Read verified actor conversation rows directly from the SQL identity model. */
export async function actorRows(
  options: PeopleApiQueryOptions = {},
  email?: string,
) {
  const normalizedEmail = normalizeEmail(email);
  const rows = await (options.db ?? getDb())
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      destinationVisibility: juniorDestinations.visibility,
      email: juniorUsers.primaryEmailNormalized,
      executionStatus: juniorConversations.executionStatus,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      handle: juniorIdentities.handle,
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: juniorIdentities.providerSubjectId,
      runId: juniorConversations.runId,
      source: juniorConversations.source,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
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
