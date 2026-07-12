import { and, asc, desc, eq, gte, isNull, lte } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import type { ConversationStatsItem, ConversationStatsReport } from "./schema";

const SAMPLE_LIMIT = 5_000;
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Treat every unfinished execution as active regardless of last progress. */
function signals(row: StatsRow) {
  if (row.executionStatus === "failed") {
    return { active: false, failed: true };
  }
  if (row.executionStatus === "idle") {
    return { active: false, failed: false };
  }
  return { active: true, failed: false };
}

function addConversation(
  map: Map<string, ConversationStatsItem>,
  label: string,
  rowSignals: ReturnType<typeof signals>,
  metrics: { costUsd?: number; durationMs: number; tokens?: number },
): void {
  const item = map.get(label) ?? emptyStatsItem(label);
  item.conversations += 1;
  item.durationMs += metrics.durationMs;
  if (metrics.tokens !== undefined) {
    item.tokens = (item.tokens ?? 0) + metrics.tokens;
  }
  if (metrics.costUsd !== undefined) {
    item.costUsd = addUsd(item.costUsd, metrics.costUsd);
  }
  item.active += rowSignals.active ? 1 : 0;
  item.failed += rowSignals.failed ? 1 : 0;
  map.set(label, item);
}

function statsItems(map: Map<string, ConversationStatsItem>) {
  return [...map.values()].sort(
    (left, right) =>
      right.conversations - left.conversations ||
      left.label.localeCompare(right.label),
  );
}

async function statsRows(db: JuniorDatabase, start: Date, end: Date) {
  return db
    .select({
      channelName: juniorConversations.channelName,
      destinationDisplayName: juniorDestinations.displayName,
      destinationKind: juniorDestinations.kind,
      destinationProvider: juniorDestinations.provider,
      destinationVisibility: juniorDestinations.visibility,
      durationMs: juniorConversations.durationMs,
      executionStatus: juniorConversations.executionStatus,
      identityDisplayName: juniorIdentities.displayName,
      identityEmail: juniorIdentities.emailNormalized,
      identityHandle: juniorIdentities.handle,
      identitySubjectId: juniorIdentities.providerSubjectId,
      source: juniorConversations.source,
      usage: juniorConversations.usage,
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

function usageTokens(
  usage: (typeof juniorConversations.$inferSelect)["usage"],
): number | undefined {
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

function usageCostUsd(
  usage: (typeof juniorConversations.$inferSelect)["usage"],
): number | undefined {
  const cost = usage?.cost;
  if (!cost) return undefined;
  if (cost.total !== undefined) return cost.total;
  const values = [
    cost.input,
    cost.output,
    cost.cacheRead,
    cost.cacheWrite,
  ].filter((value): value is number => value !== undefined);
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

/** Build aggregate dashboard stats from normalized durable SQL records. */
export async function readConversationStatsFromSql(): Promise<ConversationStatsReport> {
  const nowMs = Date.now();
  const windowStartMs = nowMs - WINDOW_MS;
  const rows = await statsRows(
    getDb(),
    new Date(windowStartMs),
    new Date(nowMs),
  );
  const actors = new Map<string, ConversationStatsItem>();
  const locations = new Map<string, ConversationStatsItem>();
  let active = 0;
  let costUsd: number | undefined;
  let durationMs = 0;
  let failed = 0;
  let tokens: number | undefined;

  for (const row of rows) {
    const rowSignals = signals(row);
    active += rowSignals.active ? 1 : 0;
    failed += rowSignals.failed ? 1 : 0;
    const rowTokens = usageTokens(row.usage);
    const rowCostUsd = usageCostUsd(row.usage);
    const metrics = {
      ...(rowCostUsd !== undefined ? { costUsd: rowCostUsd } : {}),
      durationMs: row.durationMs,
      ...(rowTokens !== undefined ? { tokens: rowTokens } : {}),
    };
    durationMs += metrics.durationMs;
    if (metrics.tokens !== undefined) {
      tokens = (tokens ?? 0) + metrics.tokens;
    }
    if (metrics.costUsd !== undefined) {
      costUsd = addUsd(costUsd, metrics.costUsd);
    }
    addConversation(actors, actorLabel(row), rowSignals, metrics);
    addConversation(locations, locationLabel(row), rowSignals, metrics);
  }

  return {
    active,
    conversations: rows.length,
    durationMs,
    failed,
    generatedAt: new Date(nowMs).toISOString(),
    locations: statsItems(locations),
    actors: statsItems(actors),
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: rows.length,
    source: "conversation_index",
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    truncated: rows.length >= SAMPLE_LIMIT,
    windowEnd: new Date(nowMs).toISOString(),
    windowStart: new Date(windowStartMs).toISOString(),
  };
}
