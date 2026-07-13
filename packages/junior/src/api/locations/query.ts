import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/chat/db";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  activityDays,
  emptyActivityDay,
  type DailyConversationActivity,
} from "../activity";
import type { ActorIdentity } from "../conversations/schema";
import {
  conversationSignals,
  reportDate,
  summaryFromRow,
  usageTokens,
} from "../conversations/reporting";
import type {
  LocationActorSummaryReport,
  LocationDetailReport,
  LocationDirectoryReport,
  LocationSummaryReport,
} from "./schema";

const SAMPLE_LIMIT = 5_000;
const RECENT_LIMIT = 25;
const ACTIVITY_DAYS = 30;

type AggregateMetrics = Pick<
  LocationSummaryReport,
  "active" | "conversations" | "costUsd" | "durationMs" | "failed" | "tokens"
>;

function emptyMetrics(): AggregateMetrics {
  return {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
  };
}

function addMetrics(
  target: AggregateMetrics,
  row: {
    costUsd?: number;
    durationMs: number;
    status: "active" | "completed" | "failed";
    tokens?: number;
  },
): void {
  target.conversations += 1;
  target.durationMs += row.durationMs;
  target.active += row.status === "active" ? 1 : 0;
  target.failed += row.status === "failed" ? 1 : 0;
  if (row.tokens !== undefined) {
    target.tokens = (target.tokens ?? 0) + row.tokens;
  }
  if (row.costUsd !== undefined) {
    target.costUsd =
      Math.round(((target.costUsd ?? 0) + row.costUsd) * 1e12) / 1e12;
  }
}

function publicLabel(input: {
  displayName: string | null;
  providerDestinationId: string;
}): string {
  const name = input.displayName?.trim().replace(/^#/, "");
  return name ? `#${name}` : `Public channel ${input.providerDestinationId}`;
}

function actorLabel(actor: ActorIdentity | undefined): string {
  return (
    actor?.email?.trim() ||
    actor?.fullName?.trim() ||
    actor?.slackUserName?.trim() ||
    actor?.slackUserId?.trim() ||
    "Unknown"
  );
}

function emptyActor(actor: ActorIdentity): LocationActorSummaryReport {
  return {
    ...emptyMetrics(),
    actor,
    label: actorLabel(actor),
  };
}

/** Read bounded top-level conversation rows, optionally scoped to one persisted-public destination. */
async function locationRows(db: JuniorDatabase, destinationId?: string) {
  return db
    .select({
      channelName: juniorConversations.channelName,
      conversationId: juniorConversations.conversationId,
      createdAt: juniorConversations.createdAt,
      actorIdentityId: juniorConversations.actorIdentityId,
      destinationDisplayName: juniorDestinations.displayName,
      destinationId: juniorDestinations.id,
      destinationKind: juniorDestinations.kind,
      destinationProvider: juniorDestinations.provider,
      destinationProviderId: juniorDestinations.providerDestinationId,
      destinationVisibility: juniorDestinations.visibility,
      durationMs: juniorConversations.durationMs,
      email: juniorUsers.primaryEmailNormalized,
      executionStatus: juniorConversations.executionStatus,
      executionUpdatedAt: juniorConversations.executionUpdatedAt,
      fullName: juniorUsers.displayName,
      handle: juniorIdentities.handle,
      identityEmail: juniorIdentities.email,
      identityProvider: juniorIdentities.provider,
      lastActivityAt: juniorConversations.lastActivityAt,
      providerSubjectId: juniorIdentities.providerSubjectId,
      source: juniorConversations.source,
      title: juniorConversations.title,
      updatedAt: juniorConversations.updatedAt,
      usage: juniorConversations.usage,
    })
    .from(juniorConversations)
    .leftJoin(
      juniorDestinations,
      eq(juniorDestinations.id, juniorConversations.destinationId),
    )
    .leftJoin(
      juniorIdentities,
      eq(juniorIdentities.id, juniorConversations.actorIdentityId),
    )
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        isNull(juniorConversations.parentConversationId),
        destinationId
          ? and(
              eq(juniorDestinations.id, destinationId),
              eq(juniorDestinations.visibility, "public"),
            )
          : undefined,
      ),
    )
    .orderBy(
      desc(juniorConversations.lastActivityAt),
      asc(juniorConversations.conversationId),
    )
    .limit(SAMPLE_LIMIT + 1);
}

type LocationRow = Awaited<ReturnType<typeof locationRows>>[number];

/** Prefer persisted total cost, otherwise sum the available component costs. */
function usageCostUsd(row: LocationRow): number | undefined {
  const cost = row.usage?.cost;
  if (!cost) return undefined;
  if (cost.total !== undefined) return cost.total;
  const values = [
    cost.input,
    cost.output,
    cost.cacheRead,
    cost.cacheWrite,
  ].filter((value): value is number => value !== undefined);
  return values.length
    ? values.reduce((total, value) => total + value, 0)
    : undefined;
}

/** Adapt one stored row into its privacy-safe summary and aggregate metrics. */
function rowMetrics(row: LocationRow) {
  const reportingRow = {
    ...row,
    email: row.email ?? row.identityEmail ?? "",
    providerSubjectId:
      row.identityProvider === "slack" ? (row.providerSubjectId ?? "") : "",
  };
  const summary = summaryFromRow(reportingRow);
  return {
    summary,
    metrics: {
      ...(usageCostUsd(row) !== undefined
        ? { costUsd: usageCostUsd(row) }
        : {}),
      durationMs: summary.cumulativeDurationMs,
      status: summary.status,
      ...(usageTokens(reportingRow) !== undefined
        ? { tokens: usageTokens(reportingRow) }
        : {}),
    },
  };
}

type LocationAccumulator = LocationSummaryReport;

/** Admit only complete persisted-public destinations as named locations. */
function locationFromRow(row: LocationRow): LocationAccumulator | undefined {
  if (
    row.destinationVisibility !== "public" ||
    !row.destinationId ||
    !row.destinationProvider ||
    !row.destinationProviderId ||
    !row.destinationKind
  ) {
    return undefined;
  }
  return {
    ...emptyMetrics(),
    firstSeenAt: row.createdAt.toISOString(),
    id: row.destinationId,
    kind: row.destinationKind,
    label: publicLabel({
      displayName: row.destinationDisplayName,
      providerDestinationId: row.destinationProviderId,
    }),
    lastSeenAt: row.lastActivityAt.toISOString(),
    provider: row.destinationProvider,
    providerDestinationId: row.destinationProviderId,
    visibility: "public",
  };
}

/** Load public locations plus one privacy-safe aggregate for non-public activity. */
export async function readLocationDirectoryFromSql(): Promise<LocationDirectoryReport> {
  const nowMs = Date.now();
  const rows = await locationRows(getDb());
  const sampledRows = rows.slice(0, SAMPLE_LIMIT);
  const locations = new Map<string, LocationAccumulator>();
  const privateActivity = {
    ...emptyMetrics(),
    label: "Private activity",
  };

  for (const row of sampledRows) {
    const { metrics } = rowMetrics(row);
    const initial = locationFromRow(row);
    if (!initial) {
      addMetrics(privateActivity, metrics);
      continue;
    }
    const location = locations.get(initial.id) ?? initial;
    addMetrics(location, metrics);
    location.firstSeenAt = new Date(
      Math.min(Date.parse(location.firstSeenAt), row.createdAt.getTime()),
    ).toISOString();
    location.lastSeenAt = new Date(
      Math.max(Date.parse(location.lastSeenAt), row.lastActivityAt.getTime()),
    ).toISOString();
    locations.set(location.id, location);
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    locations: [...locations.values()].sort(
      (left, right) =>
        Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt) ||
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    ),
    privateActivity,
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: sampledRows.length,
    source: "conversation_index",
    truncated: rows.length > SAMPLE_LIMIT,
  };
}

/** Load one public location's activity without exposing private destinations. */
export async function readLocationDetailFromSql(
  locationId: string,
): Promise<LocationDetailReport | undefined> {
  const nowMs = Date.now();
  const rows = await locationRows(getDb(), locationId);
  const sampledRows = rows.slice(0, SAMPLE_LIMIT);
  const first = sampledRows[0];
  const location = first ? locationFromRow(first) : undefined;
  if (!location) return undefined;

  const days = new Map<string, DailyConversationActivity>();
  const actors = new Map<string, LocationActorSummaryReport>();
  const recentConversations = [];

  for (const row of sampledRows) {
    const { metrics, summary } = rowMetrics(row);
    addMetrics(location, metrics);
    location.firstSeenAt = new Date(
      Math.min(Date.parse(location.firstSeenAt), row.createdAt.getTime()),
    ).toISOString();
    location.lastSeenAt = new Date(
      Math.max(Date.parse(location.lastSeenAt), row.lastActivityAt.getTime()),
    ).toISOString();
    recentConversations.push(summary);

    const date = reportDate(summary.lastSeenAt);
    if (date) {
      const day = days.get(date) ?? emptyActivityDay(date);
      day.conversations += 1;
      day.durationMs += metrics.durationMs;
      if (metrics.tokens !== undefined) {
        day.tokens = (day.tokens ?? 0) + metrics.tokens;
      }
      const value = conversationSignals(summary);
      day.active += value.active ? 1 : 0;
      day.failed += value.failed ? 1 : 0;
      days.set(date, day);
    }

    if (
      row.actorIdentityId &&
      (summary.actorIdentity?.email || summary.actorIdentity?.slackUserId)
    ) {
      const actor = summary.actorIdentity ?? {};
      const actorItem = actors.get(row.actorIdentityId) ?? emptyActor(actor);
      addMetrics(actorItem, metrics);
      actors.set(row.actorIdentityId, actorItem);
    }
  }

  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const activity = activityDays(days, nowMs, ACTIVITY_DAYS);
  return {
    ...location,
    activityDays: activity,
    actors: [...actors.values()].sort(
      (left, right) =>
        right.conversations - left.conversations ||
        left.label.localeCompare(right.label),
    ),
    generatedAt: new Date(nowMs).toISOString(),
    recentConversations: recentConversations.slice(0, RECENT_LIMIT),
    sampleLimit: SAMPLE_LIMIT,
    sampleSize: sampledRows.length,
    source: "conversation_index",
    truncated: rows.length > SAMPLE_LIMIT,
    windowEnd: end.toISOString(),
    windowStart: activity[0]
      ? `${activity[0].date}T00:00:00.000Z`
      : end.toISOString(),
  };
}
