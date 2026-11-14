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
 *
 * Each tool wait that the next request ends counts in the savings counters,
 * as an idle period does. A run that ends during a wait, such as at a slice
 * yield, stores the wait, and the first request of the next run of the
 * Conversation ends it. An idle period starts only after a request that ends
 * the Turn, so the two never count the same pair of requests.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import * as z from "zod";
import { logInfo, logWarn, setSpanStatus, withSpan } from "@/chat/logging";
import {
  decideWarmup,
  MIN_WARMUP_PREFIX_TOKENS,
  MINUTE_MS,
  NO_REPLY_GAP_MS,
} from "./model";
import {
  breakerOpen,
  cachedPrefixTokens,
  connectedState,
  KEY_PREFIX,
  providerCacheTtlMs,
  sendWarmup,
  cacheTtlMs,
  warmupTiming,
  warmupTooLate,
  type ModelRequest,
} from "./request";
import {
  idlePeriodSavings,
  recordIdlePeriodSavings,
  recordWarmupCost,
} from "./savings";

const TOOL_WAIT_GAPS_KEY = `${KEY_PREFIX}:gaps:tool_wait`;
const TOOL_WAIT_GAPS_MAX = 2_000;
const TOOL_WAIT_GAPS_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
// The first warmup runs at least 255 seconds after the request (the shortest
// TTL, 5 minutes, minus the margin). The return chance at time t uses only
// the gaps longer than the start of the histogram bin that holds t, which is
// 4 minutes for 255 seconds. So waits under 2 minutes do not change a
// decision, and are not recorded. This keeps the many short tool calls free
// of state writes.
const MIN_RECORDED_TOOL_WAIT_MS = 2 * MINUTE_MS;
// Warming never pays for a wait much longer than this, so a stored wait that
// no run ended by then does not count.
const STORED_WAIT_TTL_MS = 60 * MINUTE_MS;

const storedWaitSchema = z
  .object({
    modelId: z.string(),
    startedAtMs: z.number(),
    prefixTokens: z.number(),
    warmed: z.boolean(),
  })
  .strict();

type StoredWait = z.output<typeof storedWaitSchema>;

const storedWaitKey = (conversationId: string) =>
  `${KEY_PREFIX}:tool_wait:open:${conversationId}`;

/** Warm the prompt cache of one agent run while its tools run. */
export interface ToolWaitWarmer {
  /**
   * Record a finished model request. Record the tool wait that it ended, and
   * start warmups when it ended with tool calls.
   */
  record(request: ModelRequest, message: AssistantMessage): Promise<void>;
  /** Stop warmups, because the next request starts. */
  stop(): void;
  /** Stop warmups, because the tools returned. */
  toolsReturned(): void;
  /**
   * Stop warmups, because the run ended. Record a wait whose tools returned
   * without a next request in this run, such as before a slice yield. A tool
   * that is still running never returns to this run, so record its wait as
   * `NO_REPLY_GAP_MS`. Without these waits, the return chance counts only
   * the tools that returned. Store an open wait, so that the first request
   * of the next run counts its savings, unless an answer tool ended the
   * Turn: then the idle period counts them.
   */
  end(turnEnded?: boolean): Promise<void>;
}

// The cache that tool wait warmups keep warm.
interface WarmCache {
  request: ModelRequest;
  prefixTokens: number;
  ttlMs: number;
}

// A request that ended with tool calls and waits for its tools.
interface Waiting {
  request: ModelRequest;
  prefixTokens: number;
  /** A warmup was scheduled for the wait. */
  warmed: boolean;
}

/** Create the tool wait warmer of one agent run. */
export function createToolWaitWarmer(conversationId: string): ToolWaitWarmer {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: Waiting | undefined;
  // The first request of the run ends a wait that the last run stored.
  let firstRequest = true;
  // When the tools of `waiting` returned, before the next request starts.
  let returnedAtMs: number | undefined;
  // A warmup that is in flight when warmups stop must not schedule another.
  let generation = 0;

  const schedule = (cache: WarmCache, refreshedAtMs: number, cycle: number) => {
    const current = generation;
    const { cacheExpiresAtMs, delayMs } = warmupTiming(
      refreshedAtMs,
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
    const attributes: Record<string, unknown> = {
      "app.cache_warming.cycle": cycle,
      "app.cache_warming.prefix_tokens": prefixTokens,
      "app.cache_warming.trigger": "tool_wait",
    };
    return withSpan(
      "cache_warming.warmup",
      "cache_warming.warmup",
      { conversationId, modelId: request.model.id },
      async (setSpanAttributes) => {
        const setOutcome = (
          outcome: string,
          extra: Record<string, unknown> = {},
        ) =>
          setSpanAttributes({
            ...attributes,
            ...extra,
            "app.cache_warming.outcome": outcome,
          });
        const skip = (reason: string) => {
          const skipReason = { "app.cache_warming.skip_reason": reason };
          logInfo("cache_warming.warmup.skipped", {
            ...attributes,
            ...skipReason,
          });
          setOutcome("skipped", skipReason);
        };
        // A long request can leave no time before the cache expires.
        if (warmupTooLate(cacheExpiresAtMs)) {
          skip("cache_expired");
          return;
        }
        try {
          const state = await connectedState();
          if (await breakerOpen(state, request.model.id)) {
            skip("breaker_open");
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
          if (current !== generation) {
            setOutcome("skipped", {
              "app.cache_warming.skip_reason": "stopped",
            });
            return;
          }
          if (!decision.warm) {
            skip(decision.reason);
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
          if (warmup.refreshed) {
            logInfo("cache_warming.warmup.completed", attributes);
            setOutcome("completed");
            if (current === generation) {
              schedule(cache, startedAtMs, cycle + 1);
            }
          } else {
            logWarn("cache_warming.warmup.failed", attributes);
            setOutcome("missed");
          }
          // A missed warmup costs as much as one that refreshed the cache.
          // Schedule first, so the write does not delay the next warmup.
          await recordWarmupCost(request.model.id, warmup.costUsd);
        } catch (error) {
          // Nothing awaits this timer, so the failure ends here.
          logWarn("cache_warming.warmup.failed", {
            ...attributes,
            "exception.message":
              error instanceof Error ? error.message : String(error),
          });
          setOutcome("failed", {
            "error.type": error instanceof Error ? error.name : typeof error,
          });
          setSpanStatus("error");
        }
      },
      attributes,
    );
  };

  const stop = () => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
  };

  const recordWait = async (waitMs: number) => {
    if (waitMs < MIN_RECORDED_TOOL_WAIT_MS) return;
    const state = await connectedState();
    await state.appendToList(TOOL_WAIT_GAPS_KEY, waitMs, {
      maxLength: TOOL_WAIT_GAPS_MAX,
      ttlMs: TOOL_WAIT_GAPS_TTL_MS,
    });
  };

  // Take the wait that the last run of the Conversation ended in.
  const takeStoredWait = async (): Promise<StoredWait | undefined> => {
    const state = await connectedState();
    const key = storedWaitKey(conversationId);
    const stored = await state.get(key);
    if (stored === null) return undefined;
    await state.delete(key);
    return storedWaitSchema.parse(stored);
  };

  // Count the savings of the tool wait that this request ends.
  const recordSavings = async (
    previous: StoredWait,
    request: ModelRequest,
    message: AssistantMessage,
  ) => {
    const ttlMs = providerCacheTtlMs(previous.modelId);
    if (ttlMs === undefined) return;
    const savings = idlePeriodSavings({
      cacheTtlMs: ttlMs,
      gapMs: request.startedAtMs - previous.startedAtMs,
      prefixTokens: previous.prefixTokens,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      cacheReadPrice: request.model.cost.cacheRead,
      cacheWritePrice: request.model.cost.cacheWrite,
    });
    if (!savings) return;
    await recordIdlePeriodSavings(previous.modelId, savings, previous.warmed);
  };

  const storedWait = (open: Waiting): StoredWait => ({
    modelId: open.request.model.id,
    startedAtMs: open.request.startedAtMs,
    prefixTokens: open.prefixTokens,
    warmed: open.warmed,
  });

  return {
    async record(request, message) {
      stop();
      const previous = waiting;
      const stored =
        !previous && firstRequest ? await takeStoredWait() : undefined;
      firstRequest = false;
      returnedAtMs = undefined;
      const prefixTokens = cachedPrefixTokens(message);
      const ttlMs = cacheTtlMs(request);
      const warmed =
        prefixTokens >= MIN_WARMUP_PREFIX_TOKENS && ttlMs !== undefined;
      waiting =
        message.stopReason === "toolUse"
          ? { request, prefixTokens, warmed }
          : undefined;
      if (waiting && ttlMs !== undefined && warmed) {
        schedule({ request, prefixTokens, ttlMs }, request.startedAtMs, 1);
      }
      if (previous) {
        await recordWait(request.startedAtMs - previous.request.startedAtMs);
        await recordSavings(storedWait(previous), request, message);
      } else if (stored) {
        // The last run recorded this wait's gap when it ended.
        await recordSavings(stored, request, message);
      }
    },
    stop,
    toolsReturned() {
      stop();
      if (waiting) returnedAtMs ??= Date.now();
    },
    async end(turnEnded = false) {
      stop();
      const open = waiting;
      const returned = returnedAtMs;
      waiting = undefined;
      returnedAtMs = undefined;
      if (!open) return;
      if (!turnEnded) {
        const state = await connectedState();
        await state.set(
          storedWaitKey(conversationId),
          storedWait(open),
          STORED_WAIT_TTL_MS,
        );
      }
      if (returned !== undefined) {
        await recordWait(returned - open.request.startedAtMs);
        return;
      }
      // Shorter waits are not recorded, so an open wait counts only when it
      // already ran as long as a recorded one.
      if (Date.now() - open.request.startedAtMs >= MIN_RECORDED_TOOL_WAIT_MS) {
        await recordWait(NO_REPLY_GAP_MS);
      }
    },
  };
}
