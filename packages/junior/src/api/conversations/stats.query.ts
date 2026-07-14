import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import { conversationAggregateColumns } from "./aggregate";
import type { ConversationStatsItem, ConversationStatsReport } from "./schema";

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

function emptyStatsItem(label: string): ConversationStatsItem {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
  };
}

function addUsd(current: number | undefined, next: number): number {
  return Math.round(((current ?? 0) + next) * 1e12) / 1e12;
}

function actorLabel(row: {
  identityDisplayName: string | null;
  identityEmail: string | null;
  identityHandle: string | null;
  identitySubjectId: string | null;
  userDisplayName: string | null;
  userEmail: string | null;
}): string {
  return (
    row.userEmail?.trim() ||
    row.identityEmail?.trim() ||
    row.userDisplayName?.trim() ||
    row.identityDisplayName?.trim() ||
    row.identityHandle?.trim() ||
    row.identitySubjectId?.trim() ||
    "Unknown"
  );
}

function surfaceLabel(source: string | null): string {
  if (source === "scheduler") return "Scheduler";
  if (source === "api") return "API";
  if (source === "internal" || source === "local") return "Internal";
  return "Conversation";
}

/** Collapse private Slack destinations before any stored name reaches stats. */
function locationLabel(row: {
  channelName: string | null;
  destinationDisplayName: string | null;
  destinationKind: string | null;
  destinationProvider: string | null;
  destinationVisibility: string | null;
  source: string | null;
}): string {
  if (row.destinationProvider !== "slack") {
    return surfaceLabel(row.source);
  }
  if (row.destinationKind === "dm") {
    return "Direct Message";
  }
  if (row.destinationVisibility !== "public") {
    return "Private Conversation";
  }
  const name = (row.channelName ?? row.destinationDisplayName)
    ?.trim()
    .replace(/^#/, "");
  return name ? `#${name}` : "Public Channel";
}

type AggregateRow = {
  active: number;
  conversations: number;
  costUsd: number | null;
  durationMs: number;
  failed: number;
  tokens: number | null;
};

function addAggregate(
  map: Map<string, ConversationStatsItem>,
  label: string,
  row: AggregateRow,
): void {
  const item = map.get(label) ?? emptyStatsItem(label);
  item.active += row.active;
  item.conversations += row.conversations;
  item.durationMs += row.durationMs;
  item.failed += row.failed;
  if (row.tokens !== null) {
    item.tokens = (item.tokens ?? 0) + row.tokens;
  }
  if (row.costUsd !== null) {
    item.costUsd = addUsd(item.costUsd, row.costUsd);
  }
  map.set(label, item);
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      left.label.localeCompare(right.label),
  );
}

function statsWhere(start: Date, end: Date) {
  return and(
    isNull(juniorConversations.parentConversationId),
    gte(juniorConversations.lastActivityAt, start),
    lte(juniorConversations.lastActivityAt, end),
  );
}

async function aggregateStats(db: JuniorDatabase, start: Date, end: Date) {
  const where = statsWhere(start, end);
  const [totalsRows, actorRows, locationRows] = await Promise.all([
    db
      .select(conversationAggregateColumns())
      .from(juniorConversations)
      .where(where),
    db
      .select({
        identityDisplayName: juniorIdentities.displayName,
        identityEmail: juniorIdentities.emailNormalized,
        identityHandle: juniorIdentities.handle,
        identitySubjectId: juniorIdentities.providerSubjectId,
        userDisplayName: juniorUsers.displayName,
        userEmail: juniorUsers.primaryEmailNormalized,
        ...conversationAggregateColumns(),
      })
      .from(juniorConversations)
      .leftJoin(
        juniorIdentities,
        eq(juniorIdentities.id, juniorConversations.actorIdentityId),
      )
      .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
      .where(where)
      .groupBy(
        juniorIdentities.displayName,
        juniorIdentities.emailNormalized,
        juniorIdentities.handle,
        juniorIdentities.providerSubjectId,
        juniorUsers.displayName,
        juniorUsers.primaryEmailNormalized,
      ),
    db
      .select({
        channelName: juniorConversations.channelName,
        destinationDisplayName: juniorDestinations.displayName,
        destinationKind: juniorDestinations.kind,
        destinationProvider: juniorDestinations.provider,
        destinationVisibility: juniorDestinations.visibility,
        source: juniorConversations.source,
        ...conversationAggregateColumns(),
      })
      .from(juniorConversations)
      .leftJoin(
        juniorDestinations,
        eq(juniorDestinations.id, juniorConversations.destinationId),
      )
      .where(where)
      .groupBy(
        juniorConversations.channelName,
        juniorConversations.source,
        juniorDestinations.displayName,
        juniorDestinations.kind,
        juniorDestinations.provider,
        juniorDestinations.visibility,
      ),
  ]);
  return { actorRows, locationRows, totals: totalsRows[0] };
}

/** Build complete 90-day dashboard stats from normalized durable SQL records. */
export async function readConversationStatsFromSql(): Promise<ConversationStatsReport> {
  const nowMs = Date.now();
  const windowStartMs = nowMs - WINDOW_MS;
  const { actorRows, locationRows, totals } = await aggregateStats(
    getDb(),
    new Date(windowStartMs),
    new Date(nowMs),
  );
  const actors = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();

  for (const row of actorRows) {
    addAggregate(actors, actorLabel(row), row);
  }
  for (const row of locationRows) {
    addAggregate(locations, locationLabel(row), row);
  }

  return {
    active: totals?.active ?? 0,
    conversations: totals?.conversations ?? 0,
    durationMs: totals?.durationMs ?? 0,
    failed: totals?.failed ?? 0,
    generatedAt: new Date(nowMs).toISOString(),
    locations: statsItems(locations),
    actors: statsItems(actors),
    source: "conversation_index",
    ...(totals?.costUsd !== null && totals?.costUsd !== undefined
      ? { costUsd: addUsd(undefined, totals.costUsd) }
      : {}),
    ...(totals?.tokens !== null && totals?.tokens !== undefined
      ? { tokens: totals.tokens }
      : {}),
    windowEnd: new Date(nowMs).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
  };
}
