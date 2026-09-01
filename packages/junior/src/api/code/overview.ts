import { desc, eq, gte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import {
  codeOverviewReportSchema,
  codePersonReportSchema,
} from "../schema/code";
import { sumUtcHoursIntoSixHours } from "../reporting-window";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_DAYS = 30;
const ACTIVITY_DAYS = 90;

const summaryRowSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    created: z.number().int().nonnegative(),
    medianCostUsd: z.number().nonnegative().nullable(),
    medianMergeTimeMs: z.number().nonnegative().nullable(),
    merged: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  })
  .strict()
  .transform((row) => ({
    ...row,
    costUsd: row.costUsd ?? undefined,
    medianCostUsd: row.medianCostUsd ?? undefined,
    medianMergeTimeMs: row.medianMergeTimeMs ?? undefined,
  }));

const repositoryRowSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    id: z.string().min(1),
    medianCostUsd: z.number().nonnegative().nullable(),
    merged: z.number().int().nonnegative(),
    name: z.string().min(1),
    open: z.number().int().nonnegative(),
    provider: z.string().min(1),
    url: z.string().nullable(),
  })
  .strict()
  .transform((row) => ({
    ...row,
    medianCostUsd: row.medianCostUsd ?? undefined,
  }));

const activityDaySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2})?$/),
    merged: z.number().int().nonnegative(),
  })
  .strict();

function queryRows(result: unknown): unknown[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("Code overview query did not return rows");
  }
  return result.rows;
}

function startOfUtcDay(timestampMs: number): Date {
  const date = new Date(timestampMs);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function mergeRate(merged: number, closed: number): number | undefined {
  const completed = merged + closed;
  return completed > 0 ? merged / completed : undefined;
}

/**
 * Sum conversation-tree cost for one set of conversation ids.
 * Resolves each id to its root, then sums usage across that tree so child
 * turns are included exactly once per unique conversation tree.
 */
function conversationTreeCostExpr() {
  return sql`
    coalesce((
      SELECT sum(
        CASE
          WHEN conversations.usage_json->'cost'->>'total' IS NOT NULL
            THEN (conversations.usage_json->'cost'->>'total')::double precision
          WHEN coalesce(
            conversations.usage_json->'cost'->>'input',
            conversations.usage_json->'cost'->>'output',
            conversations.usage_json->'cost'->>'cacheRead',
            conversations.usage_json->'cost'->>'cacheWrite'
          ) IS NOT NULL
            THEN coalesce((conversations.usage_json->'cost'->>'input')::double precision, 0)
              + coalesce((conversations.usage_json->'cost'->>'output')::double precision, 0)
              + coalesce((conversations.usage_json->'cost'->>'cacheRead')::double precision, 0)
              + coalesce((conversations.usage_json->'cost'->>'cacheWrite')::double precision, 0)
          ELSE 0
        END
      )
      FROM junior_conversations AS conversations
      WHERE conversations.root_conversation_id IN (
        SELECT coalesce(roots.root_conversation_id, roots.conversation_id)
        FROM junior_conversations AS roots
        WHERE roots.conversation_id = ANY (conversation_ids.ids)
      )
    ), 0::double precision)
  `;
}

/** True when any linked conversation actor belongs to the subject user. */
function ownedByUserSql(conversationIds: SQL, userId: string): SQL {
  return sql`EXISTS (
    SELECT 1
    FROM unnest(${conversationIds}) AS linked(conversation_id)
    INNER JOIN junior_conversations AS conversations
      ON conversations.conversation_id = linked.conversation_id
    INNER JOIN junior_identities AS identities
      ON identities.id = conversations.actor_identity_id
    WHERE identities.user_id = ${userId}
  )`;
}

function ownershipFilter(userId: string | undefined): SQL | undefined {
  if (!userId) return undefined;
  return ownedByUserSql(sql`${juniorCodeChanges.conversationIds}`, userId);
}

async function readCodeWindows(args: {
  nowMs: number;
  userId?: string;
}) {
  const db = getDb();
  const windowEnd = new Date(args.nowMs);
  const windowStart = new Date(args.nowMs - WINDOW_DAYS * DAY_MS);
  const activityStart = startOfUtcDay(args.nowMs - (ACTIVITY_DAYS - 1) * DAY_MS);
  const changes = juniorCodeChanges;
  const ownership = ownershipFilter(args.userId);
  const conversationTreeCost = conversationTreeCostExpr();
  const activityHourEnd = new Date(args.nowMs);
  activityHourEnd.setUTCMinutes(0, 0, 0);
  const activityHourStart = new Date(
    activityHourEnd.getTime() - (7 * 24 - 1) * (DAY_MS / 24),
  );
  const [summaryResult, activityResult, activityHourResult] = await Promise.all([
    db.execute(sql`
      WITH recent_changes AS (
        SELECT
          ${changes.id},
          ${changes.openedAt},
          ${changes.mergedAt},
          ${changes.closedAt},
          ${changes.state},
          ${changes.conversationIds} AS conversation_ids
        FROM ${changes}
        ${ownership ? sql`WHERE ${ownership}` : sql``}
      ), change_costs AS (
        SELECT
          recent_changes.id,
          recent_changes.opened_at,
          conversation_ids.ids AS ids,
          ${conversationTreeCost} AS cost_usd
        FROM recent_changes
        CROSS JOIN LATERAL (
          SELECT recent_changes.conversation_ids AS ids
        ) AS conversation_ids
        WHERE recent_changes.opened_at >= ${windowStart}
      )
      SELECT
        count(*) FILTER (WHERE recent_changes.opened_at >= ${windowStart})::integer AS "created",
        count(*) FILTER (WHERE recent_changes.merged_at >= ${windowStart})::integer AS "merged",
        count(*) FILTER (
          WHERE recent_changes.state = 'closed'
            AND recent_changes.closed_at >= ${windowStart}
        )::integer AS "closed",
        count(*) FILTER (WHERE recent_changes.state = 'open')::integer AS "open",
        (
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(
              epoch FROM (recent_changes.merged_at - recent_changes.opened_at)
            ) * 1000
          ) FILTER (
            WHERE recent_changes.state = 'merged'
              AND recent_changes.merged_at >= ${windowStart}
          )
        )::double precision AS "medianMergeTimeMs",
        coalesce((
          SELECT ${conversationTreeCost}
          FROM (
            SELECT ARRAY(
              SELECT DISTINCT unnest(change_costs.ids)
              FROM change_costs
            ) AS ids
          ) AS conversation_ids
        ), 0)::double precision AS "costUsd",
        (
          SELECT percentile_cont(0.5) WITHIN GROUP (
            ORDER BY change_costs.cost_usd
          )
          FROM change_costs
          WHERE change_costs.cost_usd > 0
        )::double precision AS "medianCostUsd"
      FROM recent_changes
    `),
    db.execute(sql`
      WITH days AS (
        SELECT generate_series(
          date_trunc('day', ${activityStart}::timestamptz AT TIME ZONE 'UTC'),
          date_trunc('day', ${windowEnd}::timestamptz AT TIME ZONE 'UTC'),
          interval '1 day'
        ) AS day
      ), daily AS (
        SELECT
          date_trunc('day', event_at AT TIME ZONE 'UTC') AS day,
          count(*) FILTER (WHERE kind = 'created')::integer AS created,
          count(*) FILTER (WHERE kind = 'merged')::integer AS merged,
          count(*) FILTER (WHERE kind = 'closed')::integer AS closed
        FROM (
          SELECT ${changes.openedAt} AS event_at, 'created'::text AS kind
          FROM ${changes}
          WHERE ${changes.openedAt} >= ${activityStart}
            ${ownership ? sql`AND ${ownership}` : sql``}
          UNION ALL
          SELECT ${changes.mergedAt} AS event_at, 'merged'::text AS kind
          FROM ${changes}
          WHERE ${changes.mergedAt} >= ${activityStart}
            ${ownership ? sql`AND ${ownership}` : sql``}
          UNION ALL
          SELECT ${changes.closedAt} AS event_at, 'closed'::text AS kind
          FROM ${changes}
          WHERE ${changes.state} = 'closed'
            AND ${changes.closedAt} >= ${activityStart}
            ${ownership ? sql`AND ${ownership}` : sql``}
        ) AS events
        GROUP BY date_trunc('day', event_at AT TIME ZONE 'UTC')
      )
      SELECT
        to_char(days.day, 'YYYY-MM-DD') AS "date",
        coalesce(daily.created, 0)::integer AS "created",
        coalesce(daily.merged, 0)::integer AS "merged",
        coalesce(daily.closed, 0)::integer AS "closed"
      FROM days
      LEFT JOIN daily ON daily.day = days.day
      ORDER BY days.day
    `),
    db.execute(sql`
      WITH hours AS (
        SELECT generate_series(
          date_trunc('hour', ${activityHourStart}::timestamptz AT TIME ZONE 'UTC'),
          date_trunc('hour', ${activityHourEnd}::timestamptz AT TIME ZONE 'UTC'),
          interval '1 hour'
        ) AS hour
      ), hourly AS (
        SELECT
          date_trunc('hour', event_at AT TIME ZONE 'UTC') AS hour,
          count(*) FILTER (WHERE kind = 'created')::integer AS created,
          count(*) FILTER (WHERE kind = 'merged')::integer AS merged,
          count(*) FILTER (WHERE kind = 'closed')::integer AS closed
        FROM (
          SELECT ${changes.openedAt} AS event_at, 'created'::text AS kind
          FROM ${changes}
          WHERE ${changes.openedAt} >= ${activityHourStart}
            ${ownership ? sql`AND ${ownership}` : sql``}
          UNION ALL
          SELECT ${changes.mergedAt} AS event_at, 'merged'::text AS kind
          FROM ${changes}
          WHERE ${changes.mergedAt} >= ${activityHourStart}
            ${ownership ? sql`AND ${ownership}` : sql``}
          UNION ALL
          SELECT ${changes.closedAt} AS event_at, 'closed'::text AS kind
          FROM ${changes}
          WHERE ${changes.state} = 'closed'
            AND ${changes.closedAt} >= ${activityHourStart}
            ${ownership ? sql`AND ${ownership}` : sql``}
        ) AS events
        GROUP BY date_trunc('hour', event_at AT TIME ZONE 'UTC')
      )
      SELECT
        to_char(hours.hour, 'YYYY-MM-DD"T"HH24') AS "date",
        coalesce(hourly.created, 0)::integer AS "created",
        coalesce(hourly.merged, 0)::integer AS "merged",
        coalesce(hourly.closed, 0)::integer AS "closed"
      FROM hours
      LEFT JOIN hourly ON hourly.hour = hours.hour
      ORDER BY hours.hour
    `),
  ]);
  const summary = summaryRowSchema.parse(
    queryRows(summaryResult)[0] ?? {
      closed: 0,
      costUsd: 0,
      created: 0,
      medianCostUsd: null,
      medianMergeTimeMs: null,
      merged: 0,
      open: 0,
    },
  );
  const activityHours = z
    .array(activityDaySchema)
    .parse(queryRows(activityHourResult));
  return {
    activityDays: z.array(activityDaySchema).parse(queryRows(activityResult)),
    activityHours,
    activitySixHours: sumUtcHoursIntoSixHours({
      empty: (date) => ({ closed: 0, created: 0, date, merged: 0 }),
      hours: activityHours,
      nowMs: args.nowMs,
    }),
    summary: {
      ...summary,
      mergeRate: mergeRate(summary.merged, summary.closed),
    },
    windowEnd,
    windowStart,
  };
}

/** Read code activity created by Junior across installed code plugins. */
export async function readCodeOverview(nowMs = Date.now()) {
  const db = getDb();
  const changes = juniorCodeChanges;
  const repositories = juniorCodeRepositories;
  const windows = await readCodeWindows({ nowMs });
  const conversationTreeCost = conversationTreeCostExpr();
  const [repositoryResult, recentChanges] = await Promise.all([
    db.execute(sql`
      WITH recent_changes AS (
        SELECT
          ${changes.id},
          ${changes.repositoryId},
          ${changes.openedAt},
          ${changes.mergedAt},
          ${changes.closedAt},
          ${changes.state},
          ${changes.conversationIds} AS conversation_ids
        FROM ${changes}
        WHERE ${changes.openedAt} >= ${windows.windowStart}
          OR ${changes.mergedAt} >= ${windows.windowStart}
          OR ${changes.closedAt} >= ${windows.windowStart}
          OR ${changes.state} = 'open'
      ), change_costs AS (
        SELECT
          recent_changes.repository_id,
          conversation_ids.ids AS ids,
          ${conversationTreeCost} AS cost_usd
        FROM recent_changes
        CROSS JOIN LATERAL (
          SELECT recent_changes.conversation_ids AS ids
        ) AS conversation_ids
        WHERE recent_changes.opened_at >= ${windows.windowStart}
      )
      SELECT
        ${repositories.id} AS "id",
        ${repositories.name} AS "name",
        ${repositories.provider} AS "provider",
        ${repositories.url} AS "url",
        count(recent_changes.id) FILTER (
          WHERE recent_changes.opened_at >= ${windows.windowStart}
        )::integer AS "created",
        count(recent_changes.id) FILTER (
          WHERE recent_changes.merged_at >= ${windows.windowStart}
        )::integer AS "merged",
        count(recent_changes.id) FILTER (
          WHERE recent_changes.state = 'closed'
            AND recent_changes.closed_at >= ${windows.windowStart}
        )::integer AS "closed",
        count(recent_changes.id) FILTER (
          WHERE recent_changes.state = 'open'
        )::integer AS "open",
        (
          SELECT percentile_cont(0.5) WITHIN GROUP (
            ORDER BY change_costs.cost_usd
          )
          FROM change_costs
          WHERE change_costs.repository_id = ${repositories.id}
            AND change_costs.cost_usd > 0
        )::double precision AS "medianCostUsd"
      FROM ${repositories}
      INNER JOIN recent_changes
        ON recent_changes.repository_id = ${repositories.id}
      GROUP BY ${repositories.id}
      ORDER BY "merged" DESC, "created" DESC, ${repositories.name} ASC
      LIMIT 25
    `),
    db
      .select({
        closedAt: changes.closedAt,
        id: changes.id,
        mergedAt: changes.mergedAt,
        number: changes.number,
        openedAt: changes.openedAt,
        provider: changes.provider,
        repository: repositories.name,
        state: changes.state,
        title: changes.title,
        url: changes.url,
      })
      .from(changes)
      .innerJoin(repositories, eq(changes.repositoryId, repositories.id))
      .where(
        or(
          gte(changes.openedAt, windows.windowStart),
          gte(changes.mergedAt, windows.windowStart),
          gte(changes.closedAt, windows.windowStart),
          eq(changes.state, "open"),
        ),
      )
      .orderBy(desc(changes.updatedAt))
      .limit(25),
  ]);
  return codeOverviewReportSchema.parse({
    activityDays: windows.activityDays,
    activityHours: windows.activityHours,
    activitySixHours: windows.activitySixHours,
    changes: recentChanges.map((change) => ({
      ...change,
      closedAt: change.closedAt?.toISOString(),
      mergedAt: change.mergedAt?.toISOString(),
      openedAt: change.openedAt.toISOString(),
      title: change.title ?? undefined,
      url: change.url ?? undefined,
    })),
    generatedAt: windows.windowEnd.toISOString(),
    repositories: z
      .array(repositoryRowSchema)
      .parse(queryRows(repositoryResult))
      .map((repository) => ({
        ...repository,
        mergeRate: mergeRate(repository.merged, repository.closed),
        url: repository.url ?? undefined,
      })),
    summary: windows.summary,
    windowEnd: windows.windowEnd.toISOString(),
    windowStart: windows.windowStart.toISOString(),
  });
}

/**
 * Read person-scoped code activity linked through conversation actors on
 * Junior-owned code changes.
 */
export async function readPersonCodeOverview(args: {
  nowMs?: number;
  userId: string;
}) {
  const nowMs = args.nowMs ?? Date.now();
  const windows = await readCodeWindows({
    nowMs,
    userId: args.userId,
  });
  return codePersonReportSchema.parse({
    activityDays: windows.activityDays,
    activityHours: windows.activityHours,
    activitySixHours: windows.activitySixHours,
    generatedAt: windows.windowEnd.toISOString(),
    summary: windows.summary,
    windowEnd: windows.windowEnd.toISOString(),
    windowStart: windows.windowStart.toISOString(),
  });
}
