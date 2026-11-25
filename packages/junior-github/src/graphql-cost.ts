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
 * Return the points that a Sandbox GitHub GraphQL query can cost, and deny
 * it when that is above the cap.
 *
 * Returns undefined for requests that spend no Sandbox budget: host tool
 * requests, which name an egress operation and send small documents, and
 * requests that carry their own credential. A `rateLimit(dryRun:)` query
 * only predicts a cost, so it costs 1 point. A query whose cost the host
 * could not count is allowed, logged, and costs 1 point.
 */
export function githubSandboxGraphqlCost(
  ctx: EgressHookContext,
): number | undefined {
  const { graphql, operation, withoutCredential } = ctx.request;
  if (operation || withoutCredential || graphql?.kind !== "operation") {
    return undefined;
  }
  const query = graphql.operation;
  if (query.type !== "query") {
    return undefined;
  }
  const isDryRun =
    query.rootFields.includes("rateLimit") &&
    query.fields.some(
      (field) =>
        field.name === "rateLimit" && field.arguments.includes("dryRun"),
    );
  if (isDryRun) {
    return 1;
  }
  if (query.connectionRequests === undefined) {
    ctx.log.warn("github.egress.graphql_cost.unknown", {
      "app.github.graphql.operation_name": query.name,
    });
    return 1;
  }
  const cost = githubGraphqlCost(query.connectionRequests);
  if (cost <= GITHUB_SANDBOX_GRAPHQL_COST_LIMIT) {
    return cost;
  }
  throw new EgressPolicyDenied(
    `GitHub GraphQL query denied: it can cost about ${cost} points, and the Sandbox limit is ${GITHUB_SANDBOX_GRAPHQL_COST_LIMIT} points a query. All Conversations share one hourly GraphQL budget. Use smaller \`first\`/\`last\` page sizes, fewer nested connections, or REST endpoints such as \`gh api repos/{owner}/{repo}/commits/{ref}/check-runs\`. Do not retry this query unchanged.`,
  );
}
