import type { PluginOperationalReportContent } from "@sentry/junior-plugin-api";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import { juniorGitHubIssues, juniorGitHubPullRequests } from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOWS = [7, 30, 90] as const;

const pullRequestStatsSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    days: z.number().int().positive(),
    medianMergeTimeMs: z.number().nonnegative().nullable(),
    merged: z.number().int().nonnegative(),
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

const pullRequestRepositoryStatsSchema = z
  .object({
    closed: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    juniorOnly: z.number().int().nonnegative(),
    merged: z.number().int().nonnegative(),
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

const issueStatsSchema = z
  .object({
    closedCompleted: z.number().int().nonnegative(),
    closedDuplicate: z.number().int().nonnegative(),
    closedNotPlanned: z.number().int().nonnegative(),
    closedUnknown: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    days: z.number().int().positive(),
    medianCloseTimeMs: z.number().nonnegative().nullable(),
  })
  .strict()
  .transform((row) => ({
    ...row,
    medianCloseTimeMs: row.medianCloseTimeMs ?? undefined,
  }));

const pullRequestDaySchema = z
  .object({
    created: z.number().int().nonnegative(),
    date: z.string().date(),
  })
  .strict();

const issueDaySchema = z
  .object({
    created: z.number().int().nonnegative(),
    date: z.string().date(),
  })
  .strict();

const issueRepositoryStatsSchema = z
  .object({
    closedCompleted: z.number().int().nonnegative(),
    closedDuplicate: z.number().int().nonnegative(),
    closedNotPlanned: z.number().int().nonnegative(),
    closedUnknown: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    repository: z.string().min(1),
  })
  .strict();

type PullRequestStats = z.output<typeof pullRequestStatsSchema>;
type PullRequestRepositoryStats = z.output<
  typeof pullRequestRepositoryStatsSchema
>;
type IssueStats = z.output<typeof issueStatsSchema>;
type IssueRepositoryStats = z.output<typeof issueRepositoryStatsSchema>;
type PullRequestDay = z.output<typeof pullRequestDaySchema>;
type IssueDay = z.output<typeof issueDaySchema>;

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

async function aggregatePullRequestWindows(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<PullRequestStats[]> {
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
      WHERE ${table.openedAt} >= ${oldestStart}
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
  return z.array(pullRequestStatsSchema).parse(queryRows(result));
}

async function aggregatePullRequestDays(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<PullRequestDay[]> {
  const end = new Date(args.nowMs);
  const start = startOfUtcDay(args.nowMs - (WINDOWS.at(-1)! - 1) * DAY_MS);
  const table = juniorGitHubPullRequests;
  const result = await args.db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${start}::timestamptz AT TIME ZONE 'UTC'),
        date_trunc('day', ${end}::timestamptz AT TIME ZONE 'UTC'),
        interval '1 day'
      ) AS day
    ), daily AS (
      SELECT
        date_trunc('day', ${table.openedAt} AT TIME ZONE 'UTC') AS day,
        count(*)::integer AS created
      FROM ${table}
      WHERE ${table.openedAt} >= ${start}
      GROUP BY date_trunc('day', ${table.openedAt} AT TIME ZONE 'UTC')
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS "date",
      coalesce(daily.created, 0)::integer AS "created"
    FROM days
    LEFT JOIN daily ON daily.day = days.day
    ORDER BY days.day
  `);
  return z.array(pullRequestDaySchema).parse(queryRows(result));
}

async function aggregatePullRequestRepositories(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<PullRequestRepositoryStats[]> {
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
      count(*) FILTER (
        WHERE ${table.state} = 'merged'
          AND ${table.mergedAt} >= ${start}
          AND ${table.commitComposition} = 'junior_only'
      )::integer AS "juniorOnly"
    FROM ${table}
    WHERE ${table.openedAt} >= ${start}
      OR ${table.mergedAt} >= ${start}
      OR ${table.closedAt} >= ${start}
    GROUP BY ${table.repositoryFullName}
    ORDER BY "merged" DESC, "created" DESC, "repository" ASC
    LIMIT 25
  `);
  return z.array(pullRequestRepositoryStatsSchema).parse(queryRows(result));
}

async function aggregateIssueWindows(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<IssueStats[]> {
  const starts = WINDOWS.map(
    (days) => [days, new Date(args.nowMs - days * DAY_MS)] as const,
  );
  const oldestStart = starts.at(-1)![1];
  const table = juniorGitHubIssues;
  const result = await args.db.execute(sql`
    WITH windows(days, start_at) AS (
      VALUES
        (${starts[0][0]}::integer, ${starts[0][1]}::timestamptz),
        (${starts[1][0]}::integer, ${starts[1][1]}::timestamptz),
        (${starts[2][0]}::integer, ${starts[2][1]}::timestamptz)
    ), recent_issues AS MATERIALIZED (
      SELECT
        ${table.issueId},
        ${table.state},
        ${table.stateReason},
        ${table.openedAt},
        ${table.closedAt}
      FROM ${table}
      WHERE ${table.openedAt} >= ${oldestStart}
        OR ${table.closedAt} >= ${oldestStart}
    )
    SELECT
      windows.days AS "days",
      count(recent_issues.issue_id)
        FILTER (WHERE recent_issues.opened_at >= windows.start_at)::integer
        AS "created",
      count(recent_issues.issue_id)
        FILTER (
          WHERE recent_issues.state = 'closed'
            AND recent_issues.state_reason = 'completed'
            AND recent_issues.closed_at >= windows.start_at
        )::integer AS "closedCompleted",
      count(recent_issues.issue_id)
        FILTER (
          WHERE recent_issues.state = 'closed'
            AND recent_issues.state_reason = 'duplicate'
            AND recent_issues.closed_at >= windows.start_at
        )::integer AS "closedDuplicate",
      count(recent_issues.issue_id)
        FILTER (
          WHERE recent_issues.state = 'closed'
            AND recent_issues.state_reason = 'not_planned'
            AND recent_issues.closed_at >= windows.start_at
        )::integer AS "closedNotPlanned",
      count(recent_issues.issue_id)
        FILTER (
          WHERE recent_issues.state = 'closed'
            AND recent_issues.state_reason IS NULL
            AND recent_issues.closed_at >= windows.start_at
        )::integer AS "closedUnknown",
      (
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(
            epoch FROM (recent_issues.closed_at - recent_issues.opened_at)
          ) * 1000
        ) FILTER (
          WHERE recent_issues.state = 'closed'
            AND recent_issues.closed_at >= windows.start_at
        )
      )::double precision AS "medianCloseTimeMs"
    FROM windows
    LEFT JOIN recent_issues ON true
    GROUP BY windows.days
    ORDER BY windows.days
  `);
  return z.array(issueStatsSchema).parse(queryRows(result));
}

async function aggregateIssueDays(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<IssueDay[]> {
  const end = new Date(args.nowMs);
  const start = startOfUtcDay(args.nowMs - (WINDOWS.at(-1)! - 1) * DAY_MS);
  const table = juniorGitHubIssues;
  const result = await args.db.execute(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', ${start}::timestamptz AT TIME ZONE 'UTC'),
        date_trunc('day', ${end}::timestamptz AT TIME ZONE 'UTC'),
        interval '1 day'
      ) AS day
    ), daily AS (
      SELECT
        date_trunc('day', ${table.openedAt} AT TIME ZONE 'UTC') AS day,
        count(*)::integer AS created
      FROM ${table}
      WHERE ${table.openedAt} >= ${start}
      GROUP BY date_trunc('day', ${table.openedAt} AT TIME ZONE 'UTC')
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS "date",
      coalesce(daily.created, 0)::integer AS "created"
    FROM days
    LEFT JOIN daily ON daily.day = days.day
    ORDER BY days.day
  `);
  return z.array(issueDaySchema).parse(queryRows(result));
}

async function aggregateIssueRepositories(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<IssueRepositoryStats[]> {
  const start = new Date(args.nowMs - 30 * DAY_MS);
  const table = juniorGitHubIssues;
  const result = await args.db.execute(sql`
    SELECT
      ${table.repositoryFullName} AS "repository",
      count(*) FILTER (WHERE ${table.openedAt} >= ${start})::integer
        AS "created",
      count(*) FILTER (
        WHERE ${table.state} = 'closed'
          AND ${table.stateReason} = 'completed'
          AND ${table.closedAt} >= ${start}
      )::integer AS "closedCompleted",
      count(*) FILTER (
        WHERE ${table.state} = 'closed'
          AND ${table.stateReason} = 'duplicate'
          AND ${table.closedAt} >= ${start}
      )::integer AS "closedDuplicate",
      count(*) FILTER (
        WHERE ${table.state} = 'closed'
          AND ${table.stateReason} = 'not_planned'
          AND ${table.closedAt} >= ${start}
      )::integer AS "closedNotPlanned",
      count(*) FILTER (
        WHERE ${table.state} = 'closed'
          AND ${table.stateReason} IS NULL
          AND ${table.closedAt} >= ${start}
      )::integer AS "closedUnknown"
    FROM ${table}
    WHERE ${table.openedAt} >= ${start}
      OR ${table.closedAt} >= ${start}
    GROUP BY ${table.repositoryFullName}
    ORDER BY "created" DESC, "closedCompleted" DESC, "repository" ASC
    LIMIT 25
  `);
  return z.array(issueRepositoryStatsSchema).parse(queryRows(result));
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

function startOfUtcDay(timestampMs: number): Date {
  const date = new Date(timestampMs);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

/** Build the generic dashboard report for Junior-owned GitHub work outcomes. */
export async function buildGitHubOutcomeReport(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<PluginOperationalReportContent> {
  const [
    windows,
    pullRequestDays,
    repositories,
    issueWindows,
    issueDays,
    issueRepositories,
  ] = await Promise.all([
    aggregatePullRequestWindows(args),
    aggregatePullRequestDays(args),
    aggregatePullRequestRepositories(args),
    aggregateIssueWindows(args),
    aggregateIssueDays(args),
    aggregateIssueRepositories(args),
  ]);
  const thirtyDays = windows.find((window) => window.days === 30)!;
  const issueThirtyDays = issueWindows.find((window) => window.days === 30)!;

  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    title: "GitHub activity",
    metrics: [
      {
        label: "PR closure merge rate · 30d",
        value: formatPercent(thirtyDays.mergeRate),
      },
      {
        label: "Median PR merge time · merged in 30d",
        value: formatDuration(thirtyDays.medianMergeTimeMs),
      },
      {
        label: "Median issue close time · closed in 30d",
        value: formatDuration(issueThirtyDays.medianCloseTimeMs),
      },
    ],
    widgets: [
      {
        id: "pull-requests-created",
        type: "bar_chart",
        title: "Pull requests created",
        description: "Junior-owned pull requests opened per day",
        timeRangeDays: [...WINDOWS],
        series: [{ key: "created", label: "Created" }],
        categories: pullRequestDays.map((stats) => ({
          id: stats.date,
          label: stats.date,
          values: { created: stats.created },
        })),
      },
      {
        id: "issues-created",
        type: "bar_chart",
        title: "Issues created",
        description: "Junior-owned issues opened per day",
        timeRangeDays: [...WINDOWS],
        series: [{ key: "created", label: "Created" }],
        categories: issueDays.map((stats) => ({
          id: stats.date,
          label: stats.date,
          values: { created: stats.created },
        })),
      },
    ],
    recordSets: [
      {
        title: "Pull request repositories · 30d",
        emptyText: "No Junior-owned pull request activity yet.",
        fields: [
          { key: "repository", label: "Repository" },
          { key: "created", label: "Created" },
          { key: "juniorOnly", label: "Junior-only merges" },
          { key: "merged", label: "Merged" },
          { key: "closed", label: "Closed unmerged" },
          { key: "mergeRate", label: "Closure merge rate" },
        ],
        records: repositories.map(({ repository, ...stats }) => ({
          id: repository,
          values: {
            repository,
            created: String(stats.created),
            merged: String(stats.merged),
            closed: String(stats.closed),
            juniorOnly: String(stats.juniorOnly),
            mergeRate: formatPercent(stats.mergeRate),
          },
        })),
      },
      {
        title: "Issue repositories · 30d",
        emptyText: "No Junior-owned issue activity yet.",
        fields: [
          { key: "repository", label: "Repository" },
          { key: "created", label: "Created" },
          { key: "completed", label: "Completed" },
          { key: "duplicate", label: "Duplicate" },
          { key: "notPlanned", label: "Not planned" },
          { key: "unknown", label: "Unknown reason" },
        ],
        records: issueRepositories.map(({ repository, ...stats }) => ({
          id: repository,
          values: {
            repository,
            created: String(stats.created),
            completed: String(stats.closedCompleted),
            duplicate: String(stats.closedDuplicate),
            notPlanned: String(stats.closedNotPlanned),
            unknown: String(stats.closedUnknown),
          },
        })),
      },
    ],
  };
}
