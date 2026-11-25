/**
 * GitHub GraphQL cost cap for Sandbox requests.
 *
 * All Sandbox GraphQL reads share the App installation's hourly points
 * budget with Junior's own host calls. One nested query can cost 100 points,
 * so a script that loops over such queries can spend the whole budget in
 * minutes. This module predicts each query's cost before the credential is
 * added and denies queries above the cap.
 */
import {
  EgressPolicyDenied,
  type EgressHookContext,
} from "@sentry/junior-plugin-api";

/**
 * Most points that one Sandbox GraphQL query may cost. Commands such as
 * `gh pr view` and `gh pr checks` cost 1 point a query.
 */
const GITHUB_SANDBOX_GRAPHQL_COST_LIMIT = 20;

/**
 * Predict the points that GitHub charges for a query, from its connection
 * requests: divide by 100, round, and charge at least 1 point.
 * See https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
 */
function githubGraphqlCost(connectionRequests: number): number {
  return Math.max(1, Math.round(connectionRequests / 100));
}

/**
 * Deny a Sandbox GitHub GraphQL query whose predicted cost is above the cap.
 *
 * Host tool requests name an egress operation, and their documents are
 * small, so the cap skips them. A request that carries its own credential
 * spends its own budget, so the cap skips it too. A `rateLimit(dryRun: true)`
 * query only predicts a cost, so it is allowed. A query whose cost the host
 * could not count is allowed and logged.
 */
export function assertGitHubGraphqlCostAllowed(ctx: EgressHookContext): void {
  const { graphql, operation, withoutCredential } = ctx.request;
  if (operation || withoutCredential || graphql?.kind !== "operation") {
    return;
  }
  const query = graphql.operation;
  if (query.type !== "query") {
    return;
  }
  const isDryRun =
    query.rootFields.includes("rateLimit") &&
    query.fields.some(
      (field) =>
        field.name === "rateLimit" &&
        field.trueArguments?.includes("dryRun") === true,
    );
  if (isDryRun) {
    return;
  }
  if (query.connectionRequests === undefined) {
    ctx.log.warn("github.egress.graphql_cost.unknown", {
      "app.github.graphql.operation_name": query.name,
    });
    return;
  }
  const cost = githubGraphqlCost(query.connectionRequests);
  if (cost <= GITHUB_SANDBOX_GRAPHQL_COST_LIMIT) {
    return;
  }
  throw new EgressPolicyDenied(
    `GitHub GraphQL query denied: it can cost about ${cost} points, and the Sandbox limit is ${GITHUB_SANDBOX_GRAPHQL_COST_LIMIT} points a query. All Conversations share one hourly GraphQL budget. Use smaller \`first\`/\`last\` page sizes, fewer nested connections, or REST endpoints such as \`gh api repos/{owner}/{repo}/commits/{ref}/check-runs\`. Do not retry this query unchanged.`,
  );
}
