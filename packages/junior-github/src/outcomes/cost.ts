import { sql } from "drizzle-orm";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  juniorGitHubIssues,
  juniorGitHubPullRequestIssues,
  juniorGitHubPullRequests,
} from "../db/schema.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

const costWindowSchema = z
  .object({
    days: z.number().int().positive(),
    issueCostUsd: z.number().nonnegative().nullable(),
    medianIssueCostUsd: z.number().nonnegative().nullable(),
    medianPullRequestCostUsd: z.number().nonnegative().nullable(),
    pullRequestCostUsd: z.number().nonnegative().nullable(),
  })
  .strict()
  .transform((row) => ({
    days: row.days,
    issueCostUsd: row.issueCostUsd ?? undefined,
    medianIssueCostUsd: row.medianIssueCostUsd ?? undefined,
    medianPullRequestCostUsd: row.medianPullRequestCostUsd ?? undefined,
    pullRequestCostUsd: row.pullRequestCostUsd ?? undefined,
  }));

const repositoryCostSchema = z
  .object({
    issueCostUsd: z.number().nonnegative().nullable(),
    pullRequestCostUsd: z.number().nonnegative().nullable(),
    repository: z.string().min(1),
  })
  .strict()
  .transform((row) => ({
    issueCostUsd: row.issueCostUsd ?? undefined,
    pullRequestCostUsd: row.pullRequestCostUsd ?? undefined,
    repository: row.repository,
  }));

export type GitHubCostWindow = z.output<typeof costWindowSchema>;
export type GitHubRepositoryCost = z.output<typeof repositoryCostSchema>;

function queryRows(result: unknown): unknown[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !("rows" in result) ||
    !Array.isArray(result.rows)
  ) {
    throw new TypeError("GitHub cost query did not return rows");
  }
  return result.rows;
}

/** Return whether core conversation usage is available in this database. */
async function hasConversationUsageTable(db: GitHubDb): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT to_regclass('public.junior_conversations') IS NOT NULL AS "present"
  `);
  const row = queryRows(result)[0];
  return (
    typeof row === "object" &&
    row !== null &&
    "present" in row &&
    row.present === true
  );
}

function emptyCostWindows(windows: readonly number[]): GitHubCostWindow[] {
  return windows.map((days) => ({
    days,
    issueCostUsd: 0,
    medianIssueCostUsd: undefined,
    medianPullRequestCostUsd: undefined,
    pullRequestCostUsd: 0,
  }));
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

/** Distinct conversation ids for one PR including linked issues. */
function pullRequestConversationIdsExpr() {
  const pullRequests = juniorGitHubPullRequests;
  const issues = juniorGitHubIssues;
  return sql`
    ARRAY(
      SELECT DISTINCT unnest(
        ${pullRequests.conversationIds}
        || coalesce((
          SELECT array_agg(DISTINCT issue_conversation_id)
          FROM ${juniorGitHubPullRequestIssues} AS issue_links
          INNER JOIN ${issues} AS linked_issues
            ON lower(linked_issues.repository_full_name) =
              issue_links.issue_repository_full_name
            AND linked_issues.number = issue_links.issue_number
          CROSS JOIN LATERAL unnest(linked_issues.conversation_ids)
            AS issue_conversation_id
          WHERE issue_links.pull_request_id = ${pullRequests.pullRequestId}
        ), ARRAY[]::text[])
      )
    )
  `;
}

/** Distinct conversation ids for one issue including linked PRs. */
function issueConversationIdsExpr() {
  const pullRequests = juniorGitHubPullRequests;
  const issues = juniorGitHubIssues;
  return sql`
    ARRAY(
      SELECT DISTINCT unnest(
        ${issues.conversationIds}
        || coalesce((
          SELECT array_agg(DISTINCT pr_conversation_id)
          FROM ${juniorGitHubPullRequestIssues} AS issue_links
          INNER JOIN ${pullRequests} AS linked_prs
            ON linked_prs.pull_request_id = issue_links.pull_request_id
          CROSS JOIN LATERAL unnest(linked_prs.conversation_ids)
            AS pr_conversation_id
          WHERE issue_links.issue_repository_full_name =
            lower(${issues.repositoryFullName})
            AND issue_links.issue_number = ${issues.number}
        ), ARRAY[]::text[])
      )
    )
  `;
}

/** Aggregate PR and issue conversation cost across the standard report windows. */
export async function aggregateGitHubCostWindows(args: {
  db: GitHubDb;
  nowMs: number;
  windows: readonly number[];
}): Promise<GitHubCostWindow[]> {
  if (!(await hasConversationUsageTable(args.db))) {
    return emptyCostWindows(args.windows);
  }

  const starts = args.windows.map(
    (days) => [days, new Date(args.nowMs - days * DAY_MS)] as const,
  );
  const oldestStart = starts.at(-1)![1];
  const pullRequests = juniorGitHubPullRequests;
  const issues = juniorGitHubIssues;
  const windowValues = sql.join(
    starts.map(
      ([days, start]) => sql`(${days}::integer, ${start}::timestamptz)`,
    ),
    sql`, `,
  );
  const conversationTreeCost = conversationTreeCostExpr();
  const pullRequestConversationIds = pullRequestConversationIdsExpr();
  const issueConversationIds = issueConversationIdsExpr();

  const result = await args.db.execute(sql`
    WITH windows(days, start_at) AS (
      VALUES ${windowValues}
    ), pull_request_entities AS (
      SELECT
        ${pullRequests.openedAt} AS opened_at,
        conversation_ids.ids AS ids,
        ${conversationTreeCost} AS cost_usd
      FROM ${pullRequests}
      CROSS JOIN LATERAL (
        SELECT ${pullRequestConversationIds} AS ids
      ) AS conversation_ids
      WHERE ${pullRequests.openedAt} >= ${oldestStart}
    ), issue_entities AS (
      SELECT
        ${issues.openedAt} AS opened_at,
        conversation_ids.ids AS ids,
        ${conversationTreeCost} AS cost_usd
      FROM ${issues}
      CROSS JOIN LATERAL (
        SELECT ${issueConversationIds} AS ids
      ) AS conversation_ids
      WHERE ${issues.openedAt} >= ${oldestStart}
    ), pull_request_window AS (
      SELECT
        windows.days AS days,
        coalesce((
          SELECT ${conversationTreeCost}
          FROM (
            SELECT ARRAY(
              SELECT DISTINCT unnest(pull_request_entities.ids)
              FROM pull_request_entities
              WHERE pull_request_entities.opened_at >= windows.start_at
            ) AS ids
          ) AS conversation_ids
        ), 0)::double precision AS pull_request_cost_usd,
        (
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY pull_request_entities.cost_usd
          ) FILTER (
            WHERE pull_request_entities.opened_at >= windows.start_at
              AND pull_request_entities.cost_usd > 0
          )
        )::double precision AS median_pull_request_cost_usd
      FROM windows
      LEFT JOIN pull_request_entities ON true
      GROUP BY windows.days, windows.start_at
    ), issue_window AS (
      SELECT
        windows.days AS days,
        coalesce((
          SELECT ${conversationTreeCost}
          FROM (
            SELECT ARRAY(
              SELECT DISTINCT unnest(issue_entities.ids)
              FROM issue_entities
              WHERE issue_entities.opened_at >= windows.start_at
            ) AS ids
          ) AS conversation_ids
        ), 0)::double precision AS issue_cost_usd,
        (
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY issue_entities.cost_usd
          ) FILTER (
            WHERE issue_entities.opened_at >= windows.start_at
              AND issue_entities.cost_usd > 0
          )
        )::double precision AS median_issue_cost_usd
      FROM windows
      LEFT JOIN issue_entities ON true
      GROUP BY windows.days, windows.start_at
    )
    SELECT
      pull_request_window.days AS "days",
      pull_request_window.pull_request_cost_usd AS "pullRequestCostUsd",
      pull_request_window.median_pull_request_cost_usd
        AS "medianPullRequestCostUsd",
      issue_window.issue_cost_usd AS "issueCostUsd",
      issue_window.median_issue_cost_usd AS "medianIssueCostUsd"
    FROM pull_request_window
    INNER JOIN issue_window ON issue_window.days = pull_request_window.days
    ORDER BY pull_request_window.days
  `);

  return z.array(costWindowSchema).parse(queryRows(result));
}

/** Aggregate repository-level PR and issue cost for the trailing 30 days. */
export async function aggregateGitHubRepositoryCosts(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<GitHubRepositoryCost[]> {
  if (!(await hasConversationUsageTable(args.db))) {
    return [];
  }

  const start = new Date(args.nowMs - 30 * DAY_MS);
  const pullRequests = juniorGitHubPullRequests;
  const issues = juniorGitHubIssues;
  const conversationTreeCost = conversationTreeCostExpr();
  const pullRequestConversationIds = pullRequestConversationIdsExpr();
  const issueConversationIds = issueConversationIdsExpr();
  const result = await args.db.execute(sql`
    WITH pull_request_entities AS (
      SELECT
        ${pullRequests.repositoryFullName} AS repository,
        conversation_ids.ids AS ids
      FROM ${pullRequests}
      CROSS JOIN LATERAL (
        SELECT ${pullRequestConversationIds} AS ids
      ) AS conversation_ids
      WHERE ${pullRequests.openedAt} >= ${start}
    ), issue_entities AS (
      SELECT
        ${issues.repositoryFullName} AS repository,
        conversation_ids.ids AS ids
      FROM ${issues}
      CROSS JOIN LATERAL (
        SELECT ${issueConversationIds} AS ids
      ) AS conversation_ids
      WHERE ${issues.openedAt} >= ${start}
    ), repositories AS (
      SELECT repository FROM pull_request_entities
      UNION
      SELECT repository FROM issue_entities
    ), pull_request_totals AS (
      SELECT
        repositories.repository AS repository,
        coalesce((
          SELECT ${conversationTreeCost}
          FROM (
            SELECT ARRAY(
              SELECT DISTINCT unnest(pull_request_entities.ids)
              FROM pull_request_entities
              WHERE pull_request_entities.repository = repositories.repository
            ) AS ids
          ) AS conversation_ids
        ), 0)::double precision AS pull_request_cost_usd
      FROM repositories
    ), issue_totals AS (
      SELECT
        repositories.repository AS repository,
        coalesce((
          SELECT ${conversationTreeCost}
          FROM (
            SELECT ARRAY(
              SELECT DISTINCT unnest(issue_entities.ids)
              FROM issue_entities
              WHERE issue_entities.repository = repositories.repository
            ) AS ids
          ) AS conversation_ids
        ), 0)::double precision AS issue_cost_usd
      FROM repositories
    )
    SELECT
      repositories.repository AS "repository",
      coalesce(pull_request_totals.pull_request_cost_usd, 0)::double precision
        AS "pullRequestCostUsd",
      coalesce(issue_totals.issue_cost_usd, 0)::double precision
        AS "issueCostUsd"
    FROM repositories
    LEFT JOIN pull_request_totals
      ON pull_request_totals.repository = repositories.repository
    LEFT JOIN issue_totals
      ON issue_totals.repository = repositories.repository
    ORDER BY "pullRequestCostUsd" DESC, "issueCostUsd" DESC, "repository" ASC
  `);
  return z.array(repositoryCostSchema).parse(queryRows(result));
}

/** Format estimated model cost in USD for GitHub operational reports. */
export function formatCostUsd(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}
