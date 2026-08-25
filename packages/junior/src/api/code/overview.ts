import { desc, eq, gte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import { codeOverviewReportSchema } from "../schema/code";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_DAYS = 30;
const ACTIVITY_DAYS = 90;

const summaryRowSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    medianMergeTimeMs: z.number().nonnegative().nullable(),
    merged: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  })
  .strict()
  .transform((row) => ({
    ...row,
    medianMergeTimeMs: row.medianMergeTimeMs ?? undefined,
  }));

const repositoryRowSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    id: z.string().min(1),
    merged: z.number().int().nonnegative(),
    name: z.string().min(1),
    open: z.number().int().nonnegative(),
    provider: z.string().min(1),
    url: z.string().nullable(),
  })
  .strict();

const activityDaySchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    date: z.string().date(),
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

/** Read code activity created by Junior across installed code plugins. */
export async function readCodeOverview(nowMs = Date.now()) {
  const db = getDb();
  const windowEnd = new Date(nowMs);
  const windowStart = new Date(nowMs - WINDOW_DAYS * DAY_MS);
  const activityStart = startOfUtcDay(nowMs - (ACTIVITY_DAYS - 1) * DAY_MS);
  const changes = juniorCodeChanges;
  const repositories = juniorCodeRepositories;
  const [summaryResult, repositoryResult, activityResult, recentChanges] =
    await Promise.all([
      db.execute(sql`
      SELECT
        count(*) FILTER (WHERE ${changes.openedAt} >= ${windowStart})::integer AS "created",
        count(*) FILTER (WHERE ${changes.mergedAt} >= ${windowStart})::integer AS "merged",
        count(*) FILTER (
          WHERE ${changes.state} = 'closed' AND ${changes.closedAt} >= ${windowStart}
        )::integer AS "closed",
        count(*) FILTER (WHERE ${changes.state} = 'open')::integer AS "open",
        (
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY extract(
              epoch FROM (${changes.mergedAt} - ${changes.openedAt})
            ) * 1000
          ) FILTER (
            WHERE ${changes.state} = 'merged'
              AND ${changes.mergedAt} >= ${windowStart}
          )
        )::double precision AS "medianMergeTimeMs"
      FROM ${changes}
    `),
      db.execute(sql`
      SELECT
        ${repositories.id} AS "id",
        ${repositories.name} AS "name",
        ${repositories.provider} AS "provider",
        ${repositories.url} AS "url",
        count(${changes.id}) FILTER (WHERE ${changes.openedAt} >= ${windowStart})::integer AS "created",
        count(${changes.id}) FILTER (WHERE ${changes.mergedAt} >= ${windowStart})::integer AS "merged",
        count(${changes.id}) FILTER (
          WHERE ${changes.state} = 'closed' AND ${changes.closedAt} >= ${windowStart}
        )::integer AS "closed",
        count(${changes.id}) FILTER (WHERE ${changes.state} = 'open')::integer AS "open"
      FROM ${repositories}
      LEFT JOIN ${changes} ON ${changes.repositoryId} = ${repositories.id}
      WHERE ${changes.openedAt} >= ${windowStart}
        OR ${changes.mergedAt} >= ${windowStart}
        OR ${changes.closedAt} >= ${windowStart}
        OR ${changes.state} = 'open'
      GROUP BY ${repositories.id}
      ORDER BY "merged" DESC, "created" DESC, ${repositories.name} ASC
      LIMIT 25
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
          UNION ALL
          SELECT ${changes.mergedAt} AS event_at, 'merged'::text AS kind
          FROM ${changes}
          WHERE ${changes.mergedAt} >= ${activityStart}
          UNION ALL
          SELECT ${changes.closedAt} AS event_at, 'closed'::text AS kind
          FROM ${changes}
          WHERE ${changes.state} = 'closed'
            AND ${changes.closedAt} >= ${activityStart}
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
            gte(changes.openedAt, windowStart),
            gte(changes.mergedAt, windowStart),
            gte(changes.closedAt, windowStart),
            eq(changes.state, "open"),
          ),
        )
        .orderBy(desc(changes.updatedAt))
        .limit(25),
    ]);
  const summary = summaryRowSchema.parse(queryRows(summaryResult)[0]);
  return codeOverviewReportSchema.parse({
    activityDays: z.array(activityDaySchema).parse(queryRows(activityResult)),
    changes: recentChanges.map((change) => ({
      ...change,
      closedAt: change.closedAt?.toISOString(),
      mergedAt: change.mergedAt?.toISOString(),
      openedAt: change.openedAt.toISOString(),
      title: change.title ?? undefined,
      url: change.url ?? undefined,
    })),
    generatedAt: windowEnd.toISOString(),
    repositories: z
      .array(repositoryRowSchema)
      .parse(queryRows(repositoryResult))
      .map((repository) => ({
        ...repository,
        mergeRate: mergeRate(repository.merged, repository.closed),
        url: repository.url ?? undefined,
      })),
    summary: {
      ...summary,
      mergeRate: mergeRate(summary.merged, summary.closed),
    },
    windowEnd: windowEnd.toISOString(),
    windowStart: windowStart.toISOString(),
  });
}
