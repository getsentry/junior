import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type {
  ConversationStatsItem,
  ConversationStatsReport,
} from "@/reporting/conversations/types";

const SAMPLE_LIMIT = 5_000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const HUNG_PROGRESS_MS = 5 * 60 * 1000;

interface StatsQueryOptions {
  db?: JuniorDatabase;
}

function emptyStatsItem(label: string): ConversationStatsItem {
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

function actorLabel(row: StatsRow): string {
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
function locationLabel(row: StatsRow): string {
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

/** Running executions become hung after five minutes; other unfinished work is active. */
function signals(row: StatsRow, nowMs: number) {
  if (row.executionStatus === "failed") {
    return { active: false, failed: true, hung: false };
  }
  if (row.executionStatus === "idle") {
    return { active: false, failed: false, hung: false };
  }
  const updatedAt = (row.executionUpdatedAt ?? row.updatedAt).getTime();
  const hung =
    row.executionStatus === "running" && nowMs - updatedAt > HUNG_PROGRESS_MS;
  return { active: !hung, failed: false, hung };
}

function addConversation(
  map: Map<string, ConversationStatsItem>,
  label: string,
  rowSignals: ReturnType<typeof signals>,
): void {
  const item = map.get(label) ?? emptyStatsItem(label);
  item.conversations += 1;
  item.runs += 1;
  item.active += rowSignals.active ? 1 : 0;
  item.failed += rowSignals.failed ? 1 : 0;
  item.hung += rowSignals.hung ? 1 : 0;
  map.set(label, item);
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      left.label.localeCompare(right.label),
  );
}

async function statsRows(options: StatsQueryOptions, start: Date, end: Date) {
  return (options.db ?? getDb())
    .select({
      channelName: juniorConversations.channelName,
      destinationDisplayName: juniorDestinations.displayName,
      destinationKind: juniorDestinations.kind,
      destinationProvider: juniorDestinations.provider,
      destinationVisibility: juniorDestinations.visibility,
      executionStatus: juniorConversations.executionStatus,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      identityDisplayName: juniorIdentities.displayName,
      identityEmail: juniorIdentities.emailNormalized,
      identityHandle: juniorIdentities.handle,
      identitySubjectId: juniorIdentities.providerSubjectId,
      source: juniorConversations.source,
      updatedAt: juniorConversations.updatedAt,
      userDisplayName: juniorUsers.displayName,
      userEmail: juniorUsers.primaryEmailNormalized,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        gte(juniorConversations.lastActivityAt, start),
        lte(juniorConversations.lastActivityAt, end),
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(SAMPLE_LIMIT);
}

type StatsRow = Awaited<ReturnType<typeof statsRows>>[number];

/** Build aggregate dashboard stats from normalized durable SQL records. */
export async function readConversationStatsFromSql(
  options: StatsQueryOptions = {},
): Promise<ConversationStatsReport> {
  const nowMs = Date.now();
  const windowStartMs = nowMs - WINDOW_MS;
  const rows = await statsRows(
    options,
    new Date(windowStartMs),
    new Date(nowMs),
  );
  const actors = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();
  let active = 0;
  let failed = 0;
  let hung = 0;

  for (const row of rows) {
    const rowSignals = signals(row, nowMs);
    active += rowSignals.active ? 1 : 0;
    failed += rowSignals.failed ? 1 : 0;
    hung += rowSignals.hung ? 1 : 0;
    addConversation(actors, actorLabel(row), rowSignals);
    addConversation(locations, locationLabel(row), rowSignals);
  }

  return {
    active,
    conversations: rows.length,
    durationMs: 0,
    failed,
    generatedAt: new Date(nowMs).toISOString(),
    hung,
    locations: statsItems(locations),
    actors: statsItems(actors),
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: rows.length,
    source: "conversation_index",
    truncated: rows.length >= SAMPLE_LIMIT,
    runs: rows.length,
    windowEnd: new Date(nowMs).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
  };
}
