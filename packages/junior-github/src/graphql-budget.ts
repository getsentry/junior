/**
 * Hourly GitHub GraphQL budgets for Sandbox requests.
 *
 * The App installation has one hourly GraphQL points budget for all of
 * Junior. Each Conversation's Sandbox gets a share of it, and Sandbox
 * requests stop while the installation has only the host reserve left, so
 * host calls such as the PR next-action syncs keep working.
 *
 * Spend comes from GitHub's own rate limit headers on each response, not
 * from a prediction. A response's cost is the rise in `x-ratelimit-used`
 * since the last response that Junior saw. Spend that Junior does not see,
 * such as a webhook call that does not go through egress, counts toward the
 * next Sandbox response, so a Conversation can be charged more than its own
 * queries cost, never less.
 *
 * Counts live in the plugin cache, which every instance shares. A lost
 * entry only resets a count, which lets more requests through, never fewer.
 */
import {
  EgressPolicyDenied,
  type EgressHookContext,
  type EgressResponseHookContext,
} from "@sentry/junior-plugin-api";

/** Points that one Conversation's Sandbox may spend in one clock hour. */
const GITHUB_SANDBOX_GRAPHQL_CONVERSATION_BUDGET = 2_000;

/** Installation points that Sandbox requests leave for host calls. */
const GITHUB_GRAPHQL_HOST_RESERVE = 2_000;

const HOUR_MS = 60 * 60 * 1000;
const RATE_LIMIT_CACHE_KEY = "graphql-rate-limit";

/** The installation's GraphQL rate limit, from the last response headers. */
interface GitHubGraphqlRateLimit {
  remaining: number;
  resetAtMs: number;
  used: number;
}

function resetText(resetAtMs: number, nowMs: number): string {
  const time = new Date(resetAtMs).toISOString().slice(11, 16);
  const minutes = Math.max(1, Math.ceil((resetAtMs - nowMs) / 60_000));
  return `${time} UTC (in ${minutes} min)`;
}

function conversationKey(conversationId: string, hourStartMs: number): string {
  return `graphql-budget:${conversationId}:${hourStartMs}`;
}

// Host tool requests name an egress operation, and a request that carries
// its own credential spends its own budget. Neither spends the Sandbox's
// share of the installation budget.
function spendsSandboxBudget(request: {
  operation?: string;
  withoutCredential?: true;
}): boolean {
  return !request.operation && !request.withoutCredential;
}

/**
 * Deny a Sandbox GitHub GraphQL request when its Conversation has spent its
 * hourly budget, or when the installation has only the host reserve left.
 */
export async function assertGitHubSandboxGraphqlBudgetLeft(
  ctx: EgressHookContext,
): Promise<void> {
  if (!spendsSandboxBudget(ctx.request)) {
    return;
  }
  const nowMs = Date.now();
  const rateLimit =
    await ctx.cache.get<GitHubGraphqlRateLimit>(RATE_LIMIT_CACHE_KEY);
  if (
    rateLimit &&
    rateLimit.resetAtMs > nowMs &&
    rateLimit.remaining <= GITHUB_GRAPHQL_HOST_RESERVE
  ) {
    throw new EgressPolicyDenied(
      `GitHub GraphQL request denied: the App installation has ${rateLimit.remaining} GraphQL points left this hour, and Sandbox requests leave ${GITHUB_GRAPHQL_HOST_RESERVE} for host calls. It resets at ${resetText(rateLimit.resetAtMs, nowMs)}. Use REST endpoints such as \`gh api repos/{owner}/{repo}/pulls/{number}\` until then. Do not retry GraphQL before the reset.`,
    );
  }
  const { conversationId } = ctx.request;
  if (!conversationId) {
    return;
  }
  const hourStartMs = nowMs - (nowMs % HOUR_MS);
  const spent =
    (await ctx.cache.get<number>(
      conversationKey(conversationId, hourStartMs),
    )) ?? 0;
  if (spent < GITHUB_SANDBOX_GRAPHQL_CONVERSATION_BUDGET) {
    return;
  }
  throw new EgressPolicyDenied(
    `GitHub GraphQL request denied: this Conversation has used ${spent} of its ${GITHUB_SANDBOX_GRAPHQL_CONVERSATION_BUDGET} Sandbox GraphQL points for this hour. The budget resets at ${resetText(hourStartMs + HOUR_MS, nowMs)}. Use REST endpoints such as \`gh api repos/{owner}/{repo}/pulls/{number}\` until then.`,
  );
}

/**
 * Keep the installation's GraphQL rate limit from a response's headers, and
 * charge what the response cost to its Conversation's hourly budget when it
 * answers a Sandbox request.
 */
export async function recordGitHubGraphqlSpend(
  ctx: EgressResponseHookContext,
): Promise<void> {
  if (!ctx.grant.name.startsWith("installation-")) {
    return;
  }
  const { headers } = ctx.response;
  if (headers.get("x-ratelimit-resource") !== "graphql") {
    return;
  }
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const used = Number(headers.get("x-ratelimit-used"));
  const resetAtMs = Number(headers.get("x-ratelimit-reset")) * 1000;
  const nowMs = Date.now();
  if (
    !Number.isInteger(remaining) ||
    !Number.isInteger(used) ||
    !(resetAtMs > nowMs)
  ) {
    return;
  }
  let cost = 0;
  // The update runs under the cache's cross-instance lock, so parallel
  // responses cannot count the same points twice.
  await ctx.cache.update<GitHubGraphqlRateLimit>(
    RATE_LIMIT_CACHE_KEY,
    (current) => {
      const sameWindow = current?.resetAtMs === resetAtMs;
      // Without an earlier response in this window, the points used before
      // are unknown, so the response costs the least that GitHub charges.
      cost = sameWindow ? Math.max(1, used - current.used) : 1;
      if (sameWindow && used <= current.used) {
        return undefined;
      }
      return {
        ttlMs: resetAtMs - nowMs,
        value: { remaining, resetAtMs, used },
      };
    },
  );
  const { conversationId } = ctx.request;
  if (!conversationId || !spendsSandboxBudget(ctx.request)) {
    return;
  }
  const hourStartMs = nowMs - (nowMs % HOUR_MS);
  await ctx.cache.update<number>(
    conversationKey(conversationId, hourStartMs),
    (spent = 0) => ({
      ttlMs: hourStartMs + HOUR_MS - nowMs,
      value: spent + cost,
    }),
  );
}
