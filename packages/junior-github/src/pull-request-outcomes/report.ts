import type { PluginOperationalReportContent } from "@sentry/junior-plugin-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { juniorGitHubPullRequests } from "../db/schema.js";
import type { GitHubDb } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOWS = [7, 30, 90] as const;

const outcomeStatsSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    days: z.number().int().positive(),
    medianMergeTimeMs: z.number().nonnegative().nullable(),
    merged: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
  })
  .strict()
  .transform((row) => {
    const terminal = row.merged + row.closed;
    return {
      ...row,
      medianMergeTimeMs: row.medianMergeTimeMs ?? undefined,
      mergeRate: terminal > 0 ? row.merged / terminal : undefined,
    };
  });

const repositoryStatsSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    repository: z.string().min(1),
  })
  .strict()
  .transform((row) => {
    const terminal = row.merged + row.closed;
    return {
      ...row,
      mergeRate: terminal > 0 ? row.merged / terminal : undefined,
    };
  });

type OutcomeStats = z.output<typeof outcomeStatsSchema>;
type RepositoryStats = z.output<typeof repositoryStatsSchema>;

function queryRows(result: unknown): unknown[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("GitHub outcome query did not return rows");
  }
  return result.rows;
}

async function aggregateOutcomeWindows(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<OutcomeStats[]> {
  const starts = WINDOWS.map(
    (days) => [days, new Date(args.nowMs - days * DAY_MS)] as const,
  );
  const oldestStart = starts.at(-1)![1];
  const table = juniorGitHubPullRequests;
  const result = await args.db.execute(sql`
    WITH windows(days, start_at) AS (
      VALUES
        (${starts[0][0]}::integer, ${starts[0][1]}::timestamptz),
        (${starts[1][0]}::integer, ${starts[1][1]}::timestamptz),
        (${starts[2][0]}::integer, ${starts[2][1]}::timestamptz)
    ), recent_pull_requests AS MATERIALIZED (
      SELECT
        ${table.pullRequestId},
        ${table.state},
        ${table.openedAt},
        ${table.mergedAt},
        ${table.closedAt}
      FROM ${table}
      WHERE ${table.state} = 'open'
        OR ${table.openedAt} >= ${oldestStart}
        OR ${table.mergedAt} >= ${oldestStart}
        OR ${table.closedAt} >= ${oldestStart}
    )
    SELECT
      windows.days AS "days",
      count(recent_pull_requests.pull_request_id)
        FILTER (WHERE recent_pull_requests.opened_at >= windows.start_at)::integer
        AS "created",
      count(recent_pull_requests.pull_request_id)
        FILTER (
          WHERE recent_pull_requests.state = 'merged'
            AND recent_pull_requests.merged_at >= windows.start_at
        )::integer AS "merged",
      count(recent_pull_requests.pull_request_id)
        FILTER (
          WHERE recent_pull_requests.state = 'closed_unmerged'
            AND recent_pull_requests.closed_at >= windows.start_at
        )::integer AS "closed",
      count(recent_pull_requests.pull_request_id)
        FILTER (WHERE recent_pull_requests.state = 'open')::integer AS "open",
      (
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(
            epoch FROM (
              recent_pull_requests.merged_at - recent_pull_requests.opened_at
            )
          ) * 1000
        ) FILTER (
          WHERE recent_pull_requests.state = 'merged'
            AND recent_pull_requests.merged_at >= windows.start_at
        )
      )::double precision AS "medianMergeTimeMs"
    FROM windows
    LEFT JOIN recent_pull_requests ON true
    GROUP BY windows.days
    ORDER BY windows.days
  `);
  return z.array(outcomeStatsSchema).parse(queryRows(result));
}

async function aggregateRepositories(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<RepositoryStats[]> {
  const start = new Date(args.nowMs - 30 * DAY_MS);
  const table = juniorGitHubPullRequests;
  const result = await args.db.execute(sql`
    SELECT
      ${table.repositoryFullName} AS "repository",
      count(*) FILTER (WHERE ${table.openedAt} >= ${start})::integer
        AS "created",
      count(*) FILTER (
        WHERE ${table.state} = 'merged' AND ${table.mergedAt} >= ${start}
      )::integer AS "merged",
      count(*) FILTER (
        WHERE ${table.state} = 'closed_unmerged'
          AND ${table.closedAt} >= ${start}
      )::integer AS "closed",
      count(*) FILTER (WHERE ${table.state} = 'open')::integer AS "open"
    FROM ${table}
    WHERE ${table.state} = 'open'
      OR ${table.openedAt} >= ${start}
      OR ${table.mergedAt} >= ${start}
      OR ${table.closedAt} >= ${start}
    GROUP BY ${table.repositoryFullName}
    ORDER BY "merged" DESC, "created" DESC, "repository" ASC
    LIMIT 25
  `);
  return z.array(repositoryStatsSchema).parse(queryRows(result));
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  const hours = value / (60 * 60 * 1_000);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

/** Build the generic dashboard report for Junior-owned pull request outcomes. */
export async function buildGitHubOutcomeReport(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<PluginOperationalReportContent> {
  const [windows, repositories] = await Promise.all([
    aggregateOutcomeWindows(args),
    aggregateRepositories(args),
  ]);
  const thirtyDays = windows.find((window) => window.days === 30)!;

  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    title: "GitHub work delivered",
    metrics: [
      { label: "created · 30d", value: String(thirtyDays.created) },
      {
        label: "merged · 30d",
        tone: thirtyDays.merged > 0 ? "good" : "neutral",
        value: String(thirtyDays.merged),
      },
      { label: "closed unmerged · 30d", value: String(thirtyDays.closed) },
      { label: "open now", value: String(thirtyDays.open) },
      { label: "merge rate · 30d", value: formatPercent(thirtyDays.mergeRate) },
      {
        label: "median merge time · 30d",
        value: formatDuration(thirtyDays.medianMergeTimeMs),
      },
    ],
    recordSets: [
      {
        title: "Outcome windows",
        fields: [
          { key: "window", label: "Window" },
          { key: "created", label: "Created" },
          { key: "merged", label: "Merged" },
          { key: "closed", label: "Closed unmerged" },
          { key: "mergeRate", label: "Merge rate" },
          { key: "mergeTime", label: "Median merge time" },
        ],
        records: windows.map((stats) => ({
          id: `${stats.days}d`,
          values: {
            window: `${stats.days} days`,
            created: String(stats.created),
            merged: String(stats.merged),
            closed: String(stats.closed),
            mergeRate: formatPercent(stats.mergeRate),
            mergeTime: formatDuration(stats.medianMergeTimeMs),
          },
        })),
      },
      {
        title: "Repositories · 30d",
        emptyText: "No Junior-owned pull request activity yet.",
        fields: [
          { key: "repository", label: "Repository" },
          { key: "created", label: "Created" },
          { key: "merged", label: "Merged" },
          { key: "closed", label: "Closed unmerged" },
          { key: "open", label: "Open now" },
          { key: "mergeRate", label: "Merge rate" },
        ],
        records: repositories.map(({ repository, ...stats }) => ({
          id: repository,
          values: {
            repository,
            created: String(stats.created),
            merged: String(stats.merged),
            closed: String(stats.closed),
            open: String(stats.open),
            mergeRate: formatPercent(stats.mergeRate),
          },
        })),
      },
    ],
  };
}
