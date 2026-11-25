/**
 * Hourly GitHub GraphQL budgets for Sandbox requests.
 *
 * The App installation has one hourly GraphQL points budget for all of
 * Junior. Each Conversation's Sandbox gets a share of it, and Sandbox
 * requests stop while the installation has only the host reserve left, so
 * host calls such as the PR next-action syncs keep working.
 *
 * Counts live in the plugin cache, which every instance shares. A lost
 * entry only resets a count, which lets more requests through, never fewer.
 */
import {
  EgressPolicyDenied,
  type EgressHookContext,
  type EgressResponseHookContext,
  type PluginCache,
} from "@sentry/junior-plugin-api";
import { githubSandboxGraphqlCost } from "./graphql-cost.js";

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
}

function resetText(resetAtMs: number, nowMs: number): string {
  const time = new Date(resetAtMs).toISOString().slice(11, 16);
  const minutes = Math.max(1, Math.ceil((resetAtMs - nowMs) / 60_000));
  return `${time} UTC (in ${minutes} min)`;
}

async function assertHostReserveKept(
  cache: PluginCache,
  cost: number,
  nowMs: number,
): Promise<void> {
  const rateLimit =
    await cache.get<GitHubGraphqlRateLimit>(RATE_LIMIT_CACHE_KEY);
  if (
    !rateLimit ||
    rateLimit.resetAtMs <= nowMs ||
    rateLimit.remaining - cost >= GITHUB_GRAPHQL_HOST_RESERVE
  ) {
    return;
  }
  throw new EgressPolicyDenied(
    `GitHub GraphQL query denied: the App installation has ${rateLimit.remaining} GraphQL points left this hour, and Sandbox requests leave ${GITHUB_GRAPHQL_HOST_RESERVE} for host calls. It resets at ${resetText(rateLimit.resetAtMs, nowMs)}. Use REST endpoints such as \`gh api repos/{owner}/{repo}/pulls/{number}\` until then. Do not retry GraphQL before the reset.`,
  );
}

async function chargeConversation(
  cache: PluginCache,
  conversationId: string,
  cost: number,
  nowMs: number,
): Promise<void> {
  const hourStartMs = nowMs - (nowMs % HOUR_MS);
  const resetAtMs = hourStartMs + HOUR_MS;
  let spent = 0;
  let charged = false;
  // The update runs under the cache's cross-instance lock, so parallel
  // requests of one Conversation cannot count over each other.
  await cache.update<number>(
    `graphql-budget:${conversationId}:${hourStartMs}`,
    (current = 0) => {
      spent = current;
      if (current + cost > GITHUB_SANDBOX_GRAPHQL_CONVERSATION_BUDGET) {
        return undefined;
      }
      charged = true;
      return { ttlMs: resetAtMs - nowMs, value: current + cost };
    },
  );
  if (charged) {
    return;
  }
  throw new EgressPolicyDenied(
    `GitHub GraphQL query denied: this Conversation has used ${spent} of its ${GITHUB_SANDBOX_GRAPHQL_CONVERSATION_BUDGET} Sandbox GraphQL points for this hour, and this query can cost ${cost}. The budget resets at ${resetText(resetAtMs, nowMs)}. Use REST endpoints such as \`gh api repos/{owner}/{repo}/pulls/{number}\` until then, or make fewer GraphQL calls.`,
  );
}

/**
 * Charge a Sandbox GitHub GraphQL query to its Conversation's hourly budget,
 * after the cost cap. Deny it when the budget is spent, or when the
 * installation has only the host reserve left.
 */
export async function chargeGitHubSandboxGraphql(
  ctx: EgressHookContext,
): Promise<void> {
  const cost = githubSandboxGraphqlCost(ctx);
  if (cost === undefined) {
    return;
  }
  const nowMs = Date.now();
  await assertHostReserveKept(ctx.cache, cost, nowMs);
  if (ctx.request.conversationId) {
    await chargeConversation(
      ctx.cache,
      ctx.request.conversationId,
      cost,
      nowMs,
    );
  }
}

/**
 * Keep the installation's GraphQL rate limit from a response's headers, so
 * the next Sandbox request can check the host reserve.
 */
export async function recordGitHubGraphqlRateLimit(
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
  const resetAtMs = Number(headers.get("x-ratelimit-reset")) * 1000;
  const ttlMs = resetAtMs - Date.now();
  if (!Number.isInteger(remaining) || !(ttlMs > 0)) {
    return;
  }
  await ctx.cache.update<GitHubGraphqlRateLimit>(RATE_LIMIT_CACHE_KEY, () => ({
    ttlMs,
    value: { remaining, resetAtMs },
  }));
}
