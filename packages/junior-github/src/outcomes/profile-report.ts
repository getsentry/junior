import type { PluginOperationalReportContent } from "@sentry/junior-plugin-api";
import { sql, type SQL } from "drizzle-orm";
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
    merged: z.number().int().nonnegative(),
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
    created: z.number().int().nonnegative(),
    days: z.number().int().positive(),
  })
  .strict();

const daySchema = z
  .object({
    created: z.number().int().nonnegative(),
    date: z.string().date(),
  })
  .strict();

type PullRequestStats = z.output<typeof pullRequestStatsSchema>;
type IssueStats = z.output<typeof issueStatsSchema>;
type DayStats = z.output<typeof daySchema>;

function queryRows(result: unknown): unknown[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("GitHub profile report query did not return rows");
  }
  return result.rows;
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

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function startOfUtcDay(timestampMs: number): Date {
  const date = new Date(timestampMs);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

async function aggregatePullRequestWindows(args: {
  db: GitHubDb;
  nowMs: number;
  userId: string;
}): Promise<PullRequestStats[]> {
  const starts = WINDOWS.map(
    (days) => [days, new Date(args.nowMs - days * DAY_MS)] as const,
  );
  const oldestStart = starts.at(-1)![1];
  const table = juniorGitHubPullRequests;
  const owned = ownedByUserSql(sql`${table.conversationIds}`, args.userId);
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
      WHERE (${table.openedAt} >= ${oldestStart}
        OR ${table.mergedAt} >= ${oldestStart}
        OR ${table.closedAt} >= ${oldestStart})
        AND ${owned}
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
        )::integer AS "closed"
    FROM windows
    LEFT JOIN recent_pull_requests ON true
    GROUP BY windows.days
    ORDER BY windows.days
  `);
  return z.array(pullRequestStatsSchema).parse(queryRows(result));
}

async function aggregateIssueWindows(args: {
  db: GitHubDb;
  nowMs: number;
  userId: string;
}): Promise<IssueStats[]> {
  const starts = WINDOWS.map(
    (days) => [days, new Date(args.nowMs - days * DAY_MS)] as const,
  );
  const oldestStart = starts.at(-1)![1];
  const table = juniorGitHubIssues;
  const owned = ownedByUserSql(sql`${table.conversationIds}`, args.userId);
  const result = await args.db.execute(sql`
    WITH windows(days, start_at) AS (
      VALUES
        (${starts[0][0]}::integer, ${starts[0][1]}::timestamptz),
        (${starts[1][0]}::integer, ${starts[1][1]}::timestamptz),
        (${starts[2][0]}::integer, ${starts[2][1]}::timestamptz)
    ), recent_issues AS MATERIALIZED (
      SELECT
        ${table.issueId},
        ${table.openedAt}
      FROM ${table}
      WHERE ${table.openedAt} >= ${oldestStart}
        AND ${owned}
    )
    SELECT
      windows.days AS "days",
      count(recent_issues.issue_id)
        FILTER (WHERE recent_issues.opened_at >= windows.start_at)::integer
        AS "created"
    FROM windows
    LEFT JOIN recent_issues ON true
    GROUP BY windows.days
    ORDER BY windows.days
  `);
  return z.array(issueStatsSchema).parse(queryRows(result));
}

async function aggregateOpenedDays(args: {
  db: GitHubDb;
  nowMs: number;
  table: typeof juniorGitHubPullRequests | typeof juniorGitHubIssues;
  userId: string;
}): Promise<DayStats[]> {
  const end = new Date(args.nowMs);
  const start = startOfUtcDay(args.nowMs - (WINDOWS.at(-1)! - 1) * DAY_MS);
  const table = args.table;
  const owned = ownedByUserSql(sql`${table.conversationIds}`, args.userId);
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
        AND ${owned}
      GROUP BY date_trunc('day', ${table.openedAt} AT TIME ZONE 'UTC')
    )
    SELECT
      to_char(days.day, 'YYYY-MM-DD') AS "date",
      coalesce(daily.created, 0)::integer AS "created"
    FROM days
    LEFT JOIN daily ON daily.day = days.day
    ORDER BY days.day
  `);
  return z.array(daySchema).parse(queryRows(result));
}

/**
 * Build one person-scoped GitHub report for Junior-owned work linked to the
 * subject's conversations.
 */
export async function buildGitHubProfileReport(args: {
  db: GitHubDb;
  nowMs: number;
  userId: string;
}): Promise<PluginOperationalReportContent | undefined> {
  const [windows, pullRequestDays, issueWindows, issueDays] = await Promise.all(
    [
      aggregatePullRequestWindows(args),
      aggregateOpenedDays({
        db: args.db,
        nowMs: args.nowMs,
        table: juniorGitHubPullRequests,
        userId: args.userId,
      }),
      aggregateIssueWindows(args),
      aggregateOpenedDays({
        db: args.db,
        nowMs: args.nowMs,
        table: juniorGitHubIssues,
        userId: args.userId,
      }),
    ],
  );
  const thirtyDays = windows.find((window) => window.days === 30)!;
  const issueThirtyDays = issueWindows.find((window) => window.days === 30)!;
  const hasActivity =
    windows.some((window) => window.created + window.merged + window.closed > 0) ||
    issueWindows.some((window) => window.created > 0);
  if (!hasActivity) {
    return undefined;
  }

  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    title: "Code changes",
    metrics: [
      {
        label: "PRs opened · 30d",
        value: String(thirtyDays.created),
      },
      {
        label: "PRs merged · 30d",
        value: String(thirtyDays.merged),
      },
      {
        label: "Issues opened · 30d",
        value: String(issueThirtyDays.created),
      },
      {
        label: "PR merge rate · 30d",
        value: formatPercent(thirtyDays.mergeRate),
      },
    ],
    widgets: [
      {
        id: "pull-requests-created",
        type: "bar_chart",
        title: "Pull requests opened",
        description: "Junior-owned pull requests opened for this person per day",
        timeRangeDays: [...WINDOWS],
        series: [{ key: "created", label: "Opened" }],
        categories: pullRequestDays.map((stats) => ({
          id: stats.date,
          label: stats.date,
          values: { created: stats.created },
        })),
      },
      {
        id: "issues-created",
        type: "bar_chart",
        title: "Issues opened",
        description: "Junior-owned issues opened for this person per day",
        timeRangeDays: [...WINDOWS],
        series: [{ key: "created", label: "Opened" }],
        categories: issueDays.map((stats) => ({
          id: stats.date,
          label: stats.date,
          values: { created: stats.created },
        })),
      },
    ],
  };
}
