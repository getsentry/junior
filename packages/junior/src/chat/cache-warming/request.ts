/**
 * One cache warmup request, shared by idle warming (`warmup.ts`) and tool
 * wait warming (`tool-wait.ts`). Both use the same eligibility, request, miss
 * check, and breaker, so a broken warmup request stops both.
 */
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
} from "@earendil-works/pi-ai/compat";
import { completeText } from "@/chat/core-model";
import type { CacheRetention, ThinkingLevel } from "@/chat/pi/sdk";
import { captureMessage } from "@/chat/sentry";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  MINUTE_MS,
  WARMUP_MARGIN_MS,
  warmupFailureCountsAsMiss,
} from "./model";

export const KEY_PREFIX = "junior:cache_warming";
// While warming is on, the recorder sets this retention on agent requests, so
// Pi's PI_CACHE_RETENTION does not change them. The cost model and the warmup
// timing use the TTL of this retention (`CACHE_TTL_MS`).
export const CACHE_RETENTION: CacheRetention = "short";
// A refreshed prefix reads almost all of the stored prefix from the cache.
const REFRESHED_READ_FRACTION = 0.9;
// A miss ends only its own warming. When many recent warmups of one provider
// miss, its warmup request or cache is likely broken, so warming of that
// provider stops for every Conversation for a day. Only a miss reads the outcomes. Every other warmup
// reads only the open key.
const BREAKER_OUTCOMES_MAX = 20;
const BREAKER_MAX_MISSES = 10;
const BREAKER_OUTCOMES_TTL_MS = 6 * 60 * MINUTE_MS;
const BREAKER_OPEN_TTL_MS = 24 * 60 * MINUTE_MS;

// The breaker is per provider, so a provider whose cache behaves differently
// than its TTL says cannot stop warming for the others.
const breakerOutcomesKey = (provider: string) =>
  `${KEY_PREFIX}:breaker:${provider}:outcomes`;
const breakerOpenKey = (provider: string) =>
  `${KEY_PREFIX}:breaker:${provider}:open`;
const providerOf = (modelId: string) => modelId.split("/")[0] ?? "";

/** One model request of an agent run, as the provider received it. */
export interface ModelRequest {
  model: Model<Api>;
  context: Context;
  reasoning?: ThinkingLevel;
  cacheRetention?: CacheRetention;
  startedAtMs: number;
}

/** Connect the state adapter that holds cache warming state. */
export async function connectedState() {
  const state = getStateAdapter();
  await state.connect();
  return state;
}

/** Connected state adapter. */
export type ConnectedState = Awaited<ReturnType<typeof connectedState>>;

// How long the cache of each provider lives after a write or a read. The
// warmup timing and the reply chance use it. Warming needs a fixed TTL that a
// read refreshes. Providers without one are not listed and are not warmed.
//
// The TTLs come from models.dev (`cache.explicit.ttl` in
// providers/<provider>/models/*.toml; its api.json does not publish them).
// Check them again when a provider or model family is added:
// - https://github.com/anomalyco/models.dev/tree/dev/providers/anthropic/models
//   Every model lists ["5m", "1h"]. Junior uses the short retention.
// - https://github.com/anomalyco/models.dev/tree/dev/providers/alibaba/models
//   Every Qwen model with an explicit cache lists ["5m"].
// - https://github.com/anomalyco/models.dev/tree/dev/providers/openai/models
//   GPT-5.6 and later list ["30m"]. Earlier models list ["24h"] or nothing,
//   and Pi gives them no cache write price, so the price check skips them.
// The provider docs say that a cache hit resets the TTL:
// - https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
// - https://www.alibabacloud.com/help/en/model-studio/context-cache
// - https://platform.openai.com/docs/guides/prompt-caching ("A 30-minute
//   read refreshes coverage to at least 30 minutes after that read.")
// Not listed: MiniMax (no TTL on models.dev).
const CACHE_TTL_MS: Record<string, number> = {
  anthropic: 5 * MINUTE_MS,
  alibaba: 5 * MINUTE_MS,
  openai: 30 * MINUTE_MS,
};

/**
 * Return true when warmups can refresh the prompt cache of this request.
 * Warming pays only when a cache write costs more than a read. Pi adds a
 * thinking budget to the one-token output limit on the Anthropic Messages API
 * for models without adaptive thinking. Then a warmup could cost as much as a
 * short answer, and a smaller budget would miss the cached messages.
 */
export function supportsWarming(request: ModelRequest): boolean {
  const { model, reasoning } = request;
  const budgetThinking =
    reasoning !== undefined &&
    model.api === "anthropic-messages" &&
    (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking !==
      true;
  return (
    CACHE_TTL_MS[providerOf(model.id)] !== undefined &&
    model.cost.cacheRead > 0 &&
    model.cost.cacheWrite > model.cost.cacheRead &&
    !budgetThinking &&
    request.cacheRetention === CACHE_RETENTION
  );
}

/** Return the cache TTL of a request that Junior can warm. */
export function cacheTtlMs(request: ModelRequest): number | undefined {
  return supportsWarming(request)
    ? CACHE_TTL_MS[providerOf(request.model.id)]
    : undefined;
}

/** Return the cached prefix tokens of a finished model request. */
export function cachedPrefixTokens(message: AssistantMessage): number {
  return message.usage.cacheRead + message.usage.cacheWrite;
}

/**
 * Return when the cache that a request at `requestStartedAtMs` read or wrote
 * expires, and the delay until the warmup that refreshes it.
 */
export function warmupTiming(
  requestStartedAtMs: number,
  ttlMs: number,
): { cacheExpiresAtMs: number; delayMs: number } {
  const cacheExpiresAtMs = requestStartedAtMs + ttlMs;
  return {
    cacheExpiresAtMs,
    delayMs: cacheExpiresAtMs - WARMUP_MARGIN_MS - Date.now(),
  };
}

// A warmup this close to the cache expiry may reach the provider after it.
const LATE_WARMUP_MS = 10_000;

/**
 * Return true when a warmup is too late to refresh the cache. The cache is
 * gone, so the warmup must not run or count as a miss.
 */
export function warmupTooLate(cacheExpiresAtMs: number): boolean {
  return Date.now() + LATE_WARMUP_MS >= cacheExpiresAtMs;
}

/**
 * Return true while too many recent warmups of the model's provider missed,
 * so its warming is off.
 */
export async function breakerOpen(
  state: ConnectedState,
  modelId: string,
): Promise<boolean> {
  return (
    (await state.get<boolean>(breakerOpenKey(providerOf(modelId)))) === true
  );
}

// Count one warmup outcome. Open the breaker when too many recent warmups
// missed. Only the call that opens it reports to Sentry.
async function countOutcome(
  state: ConnectedState,
  modelId: string,
  miss: boolean,
): Promise<void> {
  const provider = providerOf(modelId);
  await state.appendToList(breakerOutcomesKey(provider), miss ? 1 : 0, {
    maxLength: BREAKER_OUTCOMES_MAX,
    ttlMs: BREAKER_OUTCOMES_TTL_MS,
  });
  if (!miss) return;
  const outcomes = await state.getList<number>(breakerOutcomesKey(provider));
  const misses = outcomes.filter((outcome) => outcome === 1).length;
  if (
    misses >= BREAKER_MAX_MISSES &&
    (await state.setIfNotExists(
      breakerOpenKey(provider),
      true,
      BREAKER_OPEN_TTL_MS,
    ))
  ) {
    captureMessage("Cache warming stopped: too many warmups missed the cache", {
      level: "error",
      fingerprint: ["cache_warming.breaker.opened", provider],
      tags: { "gen_ai.request.model": modelId },
      extra: {
        "app.cache_warming.misses": misses,
        "app.cache_warming.outcomes": outcomes.length,
      },
    });
  }
}

/**
 * Send one warmup: the same request with a one-token output limit. Count its
 * outcome for the breaker, and report a miss to Sentry. A rejected request
 * counts as a miss and rethrows, because it fails the same way for each
 * Conversation.
 */
export async function sendWarmup(
  state: ConnectedState,
  params: {
    conversationId: string;
    modelId: string;
    context: Context;
    reasoning?: ThinkingLevel;
    prefixTokens: number;
  },
): Promise<{ refreshed: boolean; attributes: Record<string, unknown> }> {
  const { conversationId, modelId, context, prefixTokens } = params;
  const { message: result } = await completeText({
    modelId,
    system: context.systemPrompt,
    messages: context.messages,
    ...(context.tools ? { tools: context.tools } : undefined),
    ...(params.reasoning ? { thinkingLevel: params.reasoning } : undefined),
    cacheRetention: CACHE_RETENTION,
    // The output is not used.
    maxTokens: 1,
    messageAttributeMode: "metadata",
    metadata: { conversationId },
    operation: "cache_warmup",
    cost: { conversationId },
    // Use the agent's gateway session, so the warmup reaches the same cache.
    sessionId: conversationId,
  }).catch(async (error: unknown) => {
    if (warmupFailureCountsAsMiss(error)) {
      await countOutcome(state, modelId, true);
    }
    throw error;
  });
  const attributes = {
    "app.cost.total_usd": result.usage.cost.total,
    "gen_ai.usage.cache_read.input_tokens": result.usage.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": result.usage.cacheWrite,
  };
  // A read below the stored prefix means that the request did not match it
  // and wrote a new cache entry.
  const refreshed =
    result.usage.cacheRead >= prefixTokens * REFRESHED_READ_FRACTION;
  if (!refreshed) {
    captureMessage("Cache warmup missed the cache", {
      level: "warning",
      fingerprint: ["cache_warming.warmup.missed", modelId],
      tags: { "gen_ai.request.model": modelId },
      extra: {
        "app.cache_warming.read_fraction":
          result.usage.cacheRead / prefixTokens,
      },
    });
  }
  await countOutcome(state, modelId, !refreshed);
  return { refreshed, attributes };
}
