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
 * cannot count, or that is not a POST, is denied.
 */
export function assertGitHubGraphqlCostAllowed(ctx: EgressHookContext): void {
  const { graphql, method, operation, withoutCredential } = ctx.request;
  if (operation || withoutCredential) {
    return;
  }
  // The host reads only POST bodies, so a query sent another way, such as
  // `GET /graphql?query=`, has no cost that the cap can check. Egress policy
  // denies a POST that the host did not read.
  if (!graphql && method.toUpperCase() !== "POST") {
    throw new EgressPolicyDenied(
      "GitHub GraphQL request denied: send GraphQL as a POST with a JSON body, so that its cost can be checked. `gh api graphql` does this.",
    );
  }
  if (graphql?.kind !== "operation") {
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
    // An unset page size, such as a null variable, hides the cost of the
    // whole query, so the cap cannot prove that it is small.
    throw new EgressPolicyDenied(
      "GitHub GraphQL query denied: its cost cannot be predicted, because a `first`/`last` page size is not an integer. Set each `first`/`last` to an integer literal, or to a variable that the request gives an integer value.",
    );
  }
  const cost = githubGraphqlCost(query.connectionRequests);
  if (cost <= GITHUB_SANDBOX_GRAPHQL_COST_LIMIT) {
    return;
  }
  throw new EgressPolicyDenied(
    `GitHub GraphQL query denied: it can cost about ${cost} points, and the Sandbox limit is ${GITHUB_SANDBOX_GRAPHQL_COST_LIMIT} points a query. All Conversations share one hourly GraphQL budget. Use smaller \`first\`/\`last\` page sizes, fewer nested connections, or REST endpoints such as \`gh api repos/{owner}/{repo}/commits/{ref}/check-runs\`. Do not retry this query unchanged.`,
  );
}
