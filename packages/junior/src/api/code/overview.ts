import { desc, eq, gte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/chat/db";
import { juniorCodeChanges, juniorCodeRepositories } from "@/db/schema";
import { codeOverviewReportSchema } from "../schema/code";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOW_DAYS = 30;

const summaryRowSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  })
  .strict();

const repositoryRowSchema = summaryRowSchema
  .extend({
    id: z.string().min(1),
    name: z.string().min(1),
    provider: z.string().min(1),
    url: z.string().nullable(),
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

/** Read code activity created by Junior across installed code plugins. */
export async function readCodeOverview(nowMs = Date.now()) {
  const db = getDb();
  const windowEnd = new Date(nowMs);
  const windowStart = new Date(nowMs - WINDOW_DAYS * DAY_MS);
  const changes = juniorCodeChanges;
  const repositories = juniorCodeRepositories;
  const [summaryResult, repositoryResult, recentChanges] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*) FILTER (WHERE ${changes.openedAt} >= ${windowStart})::integer AS "created",
        count(*) FILTER (WHERE ${changes.mergedAt} >= ${windowStart})::integer AS "merged",
        count(*) FILTER (
          WHERE ${changes.state} = 'closed' AND ${changes.closedAt} >= ${windowStart}
        )::integer AS "closed",
        count(*) FILTER (WHERE ${changes.state} = 'open')::integer AS "open"
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
  const completed = summary.merged + summary.closed;
  return codeOverviewReportSchema.parse({
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
        url: repository.url ?? undefined,
      })),
    summary: {
      ...summary,
      mergeRate: completed > 0 ? summary.merged / completed : undefined,
    },
    windowEnd: windowEnd.toISOString(),
    windowStart: windowStart.toISOString(),
  });
}
