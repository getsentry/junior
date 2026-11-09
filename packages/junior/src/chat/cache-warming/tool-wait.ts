/**
 * Prompt cache warming while a tool runs.
 *
 * A model request that ends with tool calls is followed by the next request
 * when the tools return. When a tool runs longer than the cache TTL, that
 * request writes the full history again. The request is still in memory, so a
 * timer in the running agent sends the warmup. Losing the timer only loses the
 * warmup.
 *
 * The decision is the same cost model as idle warming (`decideWarmup`). The
 * "reply" is the next request of the run, and the gaps are tool waits: the
 * time from a request that ended with tool calls to the next request.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { runWithLogContext } from "@/chat/log-context";
import { logInfo, logWarn } from "@/chat/logging";
import { decideWarmup, MIN_WARMUP_PREFIX_TOKENS, MINUTE_MS } from "./model";
import {
  breakerOpen,
  cachedPrefixTokens,
  connectedState,
  KEY_PREFIX,
  sendWarmup,
  cacheTtlMs,
  warmupTiming,
  warmupTooLate,
  type ModelRequest,
} from "./request";

const TOOL_WAIT_GAPS_KEY = `${KEY_PREFIX}:gaps:tool_wait`;
const TOOL_WAIT_GAPS_MAX = 2_000;
const TOOL_WAIT_GAPS_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
// The first warmup runs at least 165 seconds after the request (the shortest
// TTL, 5 minutes, minus the largest margin). The return chance at time t uses only the gaps longer
// than t, and the histogram bin that holds 165 seconds starts at 2 minutes.
// So shorter waits do not change a decision, and are not recorded. This
// keeps the many short tool calls free of state writes.
const MIN_RECORDED_TOOL_WAIT_MS = 2 * MINUTE_MS;

/** Warm the prompt cache of one agent run while its tools run. */
export interface ToolWaitWarmer {
  /**
   * Record a finished model request. Record the tool wait that it ended, and
   * start warmups when it ended with tool calls.
   */
  record(request: ModelRequest, message: AssistantMessage): Promise<void>;
  /** Stop warmups, because the run ended. */
  stop(): void;
}

// The cache that tool wait warmups keep warm.
interface WarmCache {
  request: ModelRequest;
  prefixTokens: number;
  ttlMs: number;
}

/** Create the tool wait warmer of one agent run. */
export function createToolWaitWarmer(conversationId: string): ToolWaitWarmer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The request that ended with tool calls and waits for its tools.
  let waiting: ModelRequest | undefined;
  // A warmup that is in flight when warmups stop must not schedule another.
  let generation = 0;

  const schedule = (cache: WarmCache, refreshedAtMs: number, cycle: number) => {
    const current = generation;
    const { cacheExpiresAtMs, delayMs } = warmupTiming(
      refreshedAtMs,
      cache.prefixTokens,
      cache.ttlMs,
    );
    timer = setTimeout(
      () => {
        timer = undefined;
        void warm(cache, cacheExpiresAtMs, cycle, current);
      },
      Math.max(0, delayMs),
    );
    // The tool keeps the run alive. The timer must not.
    timer.unref?.();
  };

  const warm = (
    cache: WarmCache,
    cacheExpiresAtMs: number,
    cycle: number,
    current: number,
  ) => {
    const { request, prefixTokens } = cache;
    return runWithLogContext(
      { conversationId, modelId: request.model.id },
      {},
      async () => {
        const attributes: Record<string, unknown> = {
          "app.cache_warming.cycle": cycle,
          "app.cache_warming.prefix_tokens": prefixTokens,
          "app.cache_warming.trigger": "tool_wait",
        };
        // A long request can leave no time before the cache expires.
        if (warmupTooLate(cacheExpiresAtMs)) {
          logInfo("cache_warming.warmup.skipped", {
            ...attributes,
            "app.cache_warming.skip_reason": "cache_expired",
          });
          return;
        }
        try {
          const state = await connectedState();
          if (await breakerOpen(state, request.model.id)) {
            logInfo("cache_warming.warmup.skipped", {
              ...attributes,
              "app.cache_warming.skip_reason": "breaker_open",
            });
            return;
          }
          const decision = decideWarmup({
            conversationGapsMs: [],
            globalGapsMs: await state.getList<number>(TOOL_WAIT_GAPS_KEY),
            idleMs: Date.now() - request.startedAtMs,
            cacheExpiryIdleMs: cacheExpiresAtMs - request.startedAtMs,
            cacheTtlMs: cache.ttlMs,
            prefixTokens,
            cacheReadPrice: request.model.cost.cacheRead,
            cacheWritePrice: request.model.cost.cacheWrite,
          });
          attributes["app.cache_warming.return_probability"] =
            decision.returnProbability;
          attributes["app.cache_warming.returns_per_warmup"] =
            decision.returnsPerWarmup;
          attributes["app.cache_warming.threshold"] = decision.threshold;
          // The tool returned while the gaps were read.
          if (current !== generation) return;
          if (!decision.warm) {
            logInfo("cache_warming.warmup.skipped", {
              ...attributes,
              "app.cache_warming.skip_reason": decision.reason,
            });
            return;
          }
          const startedAtMs = Date.now();
          const warmup = await sendWarmup(state, {
            conversationId,
            modelId: request.model.id,
            context: request.context,
            ...(request.reasoning
              ? { reasoning: request.reasoning }
              : undefined),
            prefixTokens,
          });
          Object.assign(attributes, warmup.attributes);
          if (!warmup.refreshed) {
            logWarn("cache_warming.warmup.failed", attributes);
            return;
          }
          logInfo("cache_warming.warmup.completed", attributes);
          if (current === generation) {
            schedule(cache, startedAtMs, cycle + 1);
          }
        } catch (error) {
          // Nothing awaits this timer, so the failure ends here.
          logWarn("cache_warming.warmup.failed", {
            ...attributes,
            "exception.message":
              error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
  };

  const stop = () => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    async record(request, message) {
      stop();
      const previous = waiting;
      waiting = message.stopReason === "toolUse" ? request : undefined;
      const prefixTokens = cachedPrefixTokens(message);
      const ttlMs = cacheTtlMs(request);
      if (
        waiting &&
        prefixTokens >= MIN_WARMUP_PREFIX_TOKENS &&
        ttlMs !== undefined
      ) {
        schedule({ request, prefixTokens, ttlMs }, request.startedAtMs, 1);
      }
      const waitMs = previous ? request.startedAtMs - previous.startedAtMs : 0;
      if (waitMs >= MIN_RECORDED_TOOL_WAIT_MS) {
        const state = await connectedState();
        await state.appendToList(TOOL_WAIT_GAPS_KEY, waitMs, {
          maxLength: TOOL_WAIT_GAPS_MAX,
          ttlMs: TOOL_WAIT_GAPS_TTL_MS,
        });
      }
    },
    stop,
  };
}
