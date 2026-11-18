import type { User } from "@sentry/junior-plugin-api";
import { and, eq, inArray, sql } from "drizzle-orm";
import { readAutomationTitlesByConversationId } from "@/chat/automations/execution-stats";
import { getDb } from "@/chat/db";
import { microUsdSql, microUsdToUsd } from "@/db/micro-usd";
import {
  juniorConversationMetrics,
  juniorConversations,
  juniorDestinations,
  juniorIdentities,
  juniorUsers,
} from "@/db/schema";
import {
  slackLocationLabel,
  summaryFromRow,
  surfaceLabel,
} from "../conversations/reporting";
import { readConversationAccessFromSql } from "../conversations/access";
import { readFirstHumanMessageTexts } from "../conversations/first-message";
import { readConversationTreeMetricsFromSql } from "../conversations/usage";
import type {
  ConversationStatsItem,
  ActorActivityDayReport,
  ActorIdentity,
  ActorProfileReport,
} from "../schema/person";
import {
  ACTIVITY_DAYS,
  activityDays,
  activityHours,
  activitySixHours,
  conversationRootId,
  emptyActivityDay,
  emptyTotals,
  metricSum,
  normalizeEmail,
  personRootJoin,
  personRoots,
  personTotalColumns,
  recentActorRows,
  rootAggregateColumns,
  statsItems,
  turnRoot,
  verifiedActorWhere,
} from "./shared";
import { trailingUtcHourWindow } from "../reporting-window";

type AggregateRow = {
  active: number;
  conversations: number;
  durationMs: number;
  failed: number;
  tokens: number | null;
};

function emptyProfile(email: string, nowMs: number): ActorProfileReport {
  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  return {
    activityDays: activityDays(new Map(), nowMs),
    activityHours: activityHours(new Map(), nowMs),
    activitySixHours: activitySixHours(new Map(), nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: [],
    recentConversations: [],
    actor: { email },
    source: "conversation_index",
    surfaces: [],
    totals: emptyTotals(),
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}

function addAggregate(
  map: Map<string, ConversationStatsItem>,
  label: string,
  row: AggregateRow,
): void {
  const item = map.get(label) ?? {
    active: 0,
    conversations: 0,
    durationMs: 0,
    failed: 0,
    label,
  };
  item.active += row.active;
  item.conversations += row.conversations;
  item.durationMs += row.durationMs;
  item.failed += row.failed;
  if (row.tokens !== null) item.tokens = (item.tokens ?? 0) + row.tokens;
  map.set(label, item);
}

function surfaceExpression(table: typeof turnRoot) {
  return sql<string>`CASE
    WHEN ${table.source} IN ('api', 'scheduler', 'slack')
      THEN ${table.source}
    -- Dashboard Conversations share the product api surface label.
    WHEN ${table.source} = 'web' THEN 'api'
    WHEN ${table.conversationId} LIKE 'slack:%' THEN 'slack'
    WHEN ${table.conversationId} LIKE 'scheduler:%' THEN 'scheduler'
    WHEN ${table.conversationId} LIKE 'api:%' THEN 'api'
    ELSE 'internal'
  END`;
}

function channelExpression(table: typeof turnRoot) {
  return sql<string>`SPLIT_PART(${table.conversationId}, ':', 2)`;
}

function locationLabel(row: {
  channel: string;
  channelName: string | null;
  destinationVisibility: string | null;
  surface: string;
}): string {
  if (row.surface !== "slack")
    return surfaceLabel(row.surface as "api" | "internal" | "scheduler");
  if (row.destinationVisibility !== "public") return "Private Conversation";
  return (
    slackLocationLabel({
      channel: row.channel || undefined,
      channelName: row.channelName ?? undefined,
    }) ?? "Conversation"
  );
}

function activityBuckets(
  rows: (AggregateRow & { costMicroUsd: number | null; date: string })[],
): Map<string, ActorActivityDayReport> {
  return new Map(
    rows.map(({ costMicroUsd, tokens, ...row }) => [
      row.date,
      {
        ...emptyActivityDay(row.date),
        ...row,
        ...(costMicroUsd !== null
          ? { costUsd: microUsdToUsd(costMicroUsd) }
          : undefined),
        ...(tokens !== null ? { tokens } : undefined),
      },
    ]),
  );
}

/**
 * Sum one person's Turns into UTC day or hour buckets since `since`. A root
 * counts once in each bucket where the person ran a Turn in it. Its current
 * status counts only in the bucket of their last Turn in that root, so a
 * status change does not mark every past bucket.
 */
function rootBucketRows(args: {
  email: string;
  since: Date;
  unit: "day" | "hour";
}) {
  const metrics = juniorConversationMetrics;
  // A literal, so the grouped and selected bucket expressions match.
  const unit = sql.raw(`'${args.unit}'`);
  const bucket = sql<Date>`date_trunc(${unit}, ${metrics.occurredAt} AT TIME ZONE 'UTC')`;
  const format = args.unit === "day" ? "YYYY-MM-DD" : 'YYYY-MM-DD"T"HH24';
  // All of the person's Turns, so the last Turn of each root is known.
  const rootBuckets = getDb()
    .select({
      bucket: bucket.as("bucket_start"),
      rootConversationId: conversationRootId.as("bucket_root_id"),
      lastAt: sql`max(${metrics.occurredAt})`.as("bucket_last_at"),
      costMicroUsd: metricSum("cost_micro_usd").as("bucket_cost_micro_usd"),
      durationMs: metricSum("duration_ms").as("bucket_duration_ms"),
      tokens: metricSum("total_tokens").as("bucket_tokens"),
    })
    .from(metrics)
    .innerJoin(
      juniorIdentities,
      eq(juniorIdentities.id, metrics.actorIdentityId),
    )
    .innerJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .innerJoin(
      juniorConversations,
      eq(juniorConversations.conversationId, metrics.conversationId),
    )
    .where(
      and(
        verifiedActorWhere(args.email),
        inArray(metrics.metric, [
          "cost_micro_usd",
          "duration_ms",
          "total_tokens",
        ]),
      ),
    )
    .groupBy(bucket, conversationRootId)
    .as("person_root_buckets");
  // The window reads one row per bucket and root, not one per metric row.
  const buckets = getDb()
    .select({
      bucket: rootBuckets.bucket,
      rootConversationId: rootBuckets.rootConversationId,
      isLastTurn:
        sql<boolean>`${rootBuckets.lastAt} = max(${rootBuckets.lastAt}) OVER (
        PARTITION BY ${rootBuckets.rootConversationId}
      )`.as("bucket_has_last_turn"),
      costMicroUsd: rootBuckets.costMicroUsd,
      durationMs: rootBuckets.durationMs,
      tokens: rootBuckets.tokens,
    })
    .from(rootBuckets)
    .as("person_buckets");
  return getDb()
    .select({
      active: sql<number>`(count(*) FILTER (
        WHERE ${buckets.isLastTurn} AND ${turnRoot.executionStatus} NOT IN ('idle', 'failed')
      ))::integer`,
      conversations: sql<number>`count(*)::integer`,
      costMicroUsd: microUsdSql(sql`sum(${buckets.costMicroUsd})`),
      date: sql<string>`TO_CHAR(${buckets.bucket}, ${sql.raw(`'${format}'`)})`,
      durationMs: sql<number>`COALESCE(sum(${buckets.durationMs}), 0)::double precision`,
      // A stopped Conversation reports `stopped`, not `failed`.
      failed: sql<number>`(count(*) FILTER (
        WHERE ${buckets.isLastTurn}
          AND ${turnRoot.executionStatus} = 'failed'
          AND ${turnRoot.stoppedAt} IS NULL
      ))::integer`,
      tokens: sql<number | null>`sum(${buckets.tokens})::double precision`,
    })
    .from(buckets)
    .innerJoin(
      turnRoot,
      eq(turnRoot.conversationId, buckets.rootConversationId),
    )
    .where(
      sql`${buckets.bucket} >= (${args.since.toISOString()}::timestamptz AT TIME ZONE 'UTC')`,
    )
    .groupBy(buckets.bucket);
}

/** Load one complete person profile while bounding only its recent-conversation list. */
export async function readPeopleProfileFromSql(
  email: string,
  options: { viewer?: User } = {},
): Promise<ActorProfileReport> {
  const nowMs = Date.now();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return emptyProfile("", nowMs);

  const end = new Date(nowMs);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (ACTIVITY_DAYS - 1));
  const roots = personRoots(normalizedEmail);
  const aggregate = rootAggregateColumns(roots);
  const surface = surfaceExpression(turnRoot);
  const channel = channelExpression(turnRoot);
  const hourWindow = trailingUtcHourWindow(nowMs, 7 * 24);
  const [totalsRows, dayRows, hourRows, locationRows, surfaceRows, recentRows] =
    await Promise.all([
      getDb()
        .select(personTotalColumns(roots))
        .from(roots)
        .innerJoin(juniorUsers, eq(juniorUsers.id, roots.userId))
        .innerJoin(turnRoot, personRootJoin(roots))
        .groupBy(juniorUsers.id),
      rootBucketRows({ email: normalizedEmail, since: start, unit: "day" }),
      rootBucketRows({
        email: normalizedEmail,
        since: hourWindow.start,
        unit: "hour",
      }),
      getDb()
        .select({
          channel,
          channelName: turnRoot.channelName,
          destinationVisibility: juniorDestinations.visibility,
          surface,
          ...aggregate,
        })
        .from(roots)
        .innerJoin(turnRoot, personRootJoin(roots))
        .leftJoin(
          juniorDestinations,
          eq(juniorDestinations.id, turnRoot.destinationId),
        )
        .groupBy(
          channel,
          turnRoot.channelName,
          juniorDestinations.visibility,
          surface,
        ),
      getDb()
        .select({ surface, ...aggregate })
        .from(roots)
        .innerJoin(turnRoot, personRootJoin(roots))
        .groupBy(surface),
      recentActorRows(normalizedEmail),
    ]);

  const person = totalsRows[0];
  if (!person) return emptyProfile(normalizedEmail, nowMs);

  const actor: ActorIdentity & { email: string } = {
    email: person.email,
    ...(person.fullName ? { fullName: person.fullName } : undefined),
    ...(person.slackUserId ? { slackUserId: person.slackUserId } : undefined),
    ...(person.slackUserName
      ? { slackUserName: person.slackUserName }
      : undefined),
  };
  const days = activityBuckets(dayRows);
  const hours = activityBuckets(hourRows);
  const locations = new Map<string, ConversationStatsItem>();
  for (const row of locationRows) {
    addAggregate(locations, locationLabel(row), row);
  }
  const surfaces = new Map<string, ConversationStatsItem>();
  for (const row of surfaceRows) {
    addAggregate(
      surfaces,
      surfaceLabel(row.surface as "api" | "internal" | "scheduler" | "slack"),
      row,
    );
  }
  const recentConversationIds = recentRows.map((row) => row.conversationId);
  const [
    accessByConversation,
    metricsByRoot,
    automationTitleByConversation,
    firstHumanMessageTextByConversation,
  ] = await Promise.all([
    readConversationAccessFromSql(
      getDb(),
      recentConversationIds,
      options.viewer,
    ),
    readConversationTreeMetricsFromSql(getDb(), recentConversationIds),
    readAutomationTitlesByConversationId(recentRows),
    readFirstHumanMessageTexts(getDb(), recentRows),
  ]);

  return {
    activityDays: activityDays(days, nowMs),
    activityHours: activityHours(hours, nowMs),
    activitySixHours: activitySixHours(hours, nowMs),
    generatedAt: new Date(nowMs).toISOString(),
    locations: statsItems(locations),
    recentConversations: recentRows.map((row) =>
      summaryFromRow(row, {
        access: accessByConversation.get(row.conversationId),
        automationTitle: automationTitleByConversation.get(row.conversationId),
        firstHumanMessageText: firstHumanMessageTextByConversation.get(
          row.conversationId,
        ),
        metrics: metricsByRoot.get(row.conversationId),
      }),
    ),
    actor,
    source: "conversation_index",
    surfaces: statsItems(surfaces),
    totals: {
      active: person.active,
      activeDays: person.activeDays,
      conversations: person.conversations,
      durationMs: person.durationMs,
      failed: person.failed,
      ...(person.tokens !== null ? { tokens: person.tokens } : undefined),
    },
    windowEnd: end.toISOString(),
    windowStart: start.toISOString(),
  };
}
