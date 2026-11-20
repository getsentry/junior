/**
 * Hourly counters of cache warming outcomes and of the prompt cache of agent
 * model calls, for the System page. They diagnose recent hours, so unlike
 * the savings counters they have no daily rows.
 *
 * The savings counters (`savings.ts`) say what warming saved. These say why:
 * how warmups ended, and whether agent calls read the cache at all. A cache
 * that the provider drops shows as full rewrites here even when no warmup
 * ran, so the savings counters miss it.
 */
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { logWarn } from "@/chat/logging";
import { addHourlyStats, addStats, type Stat, type StatKey } from "@/stats";

type Usage = AssistantMessage["usage"];

/** Namespace of the cache warming counters. */
export const CACHE_WARMING_NAMESPACE = "cache_warming";
/** Namespace of the prompt cache counters of agent model calls. */
export const MODEL_CACHE_NAMESPACE = "model_cache";

/**
 * Warmup outcome metrics. The counter name is the detail: the model for
 * `missed` and `warmed_rewrites`, the turn ending (or `tool_wait`) for
 * `sent`, the skip reason for `skipped`, and the provider for the breaker.
 */
export const OUTCOME_METRICS = {
  sent: "warmups_sent",
  missed: "warmups_missed",
  skipped: "warmups_skipped",
  warmedRewrites: "warmed_rewrites",
  breakerOpened: "breaker_opened",
  breakerClosed: "breaker_closed",
} as const;

/**
 * Prompt cache metrics of agent model calls, by model. `input_tokens` counts
 * every input token, cached or not, so write share is
 * `cache_write_tokens / input_tokens`.
 */
export const MODEL_CACHE_METRICS = {
  calls: "calls",
  inputTokens: "input_tokens",
  cacheWriteTokens: "cache_write_tokens",
  cacheReadTokens: "cache_read_tokens",
  fullRewrites: "full_rewrites",
} as const;

// A call that wrote this much and read this little rewrote its whole prefix.
const FULL_REWRITE_MIN_WRITE = 50_000;
const FULL_REWRITE_MAX_READ = 20_000;

/** Return true for a call that wrote its prefix again instead of reading it. */
export function isFullRewrite(
  usage: Pick<Usage, "cacheRead" | "cacheWrite">,
): boolean {
  return (
    usage.cacheWrite > FULL_REWRITE_MIN_WRITE &&
    usage.cacheRead < FULL_REWRITE_MAX_READ
  );
}

const HOURLY_ONLY_METRICS = new Set<string>(Object.values(OUTCOME_METRICS));
const hourlyOnly = (amount: StatKey) =>
  amount.namespace === MODEL_CACHE_NAMESPACE ||
  HOURLY_ONLY_METRICS.has(amount.metric);

/**
 * Add amounts to the hourly counters, and the savings amounts also to the
 * daily counters, in at most one statement each. The counters only report,
 * so a failure to write them is logged and does not change warming or the
 * run.
 */
export async function addCacheCounters(
  amounts: Array<StatKey & { count: number }>,
): Promise<void> {
  if (!process.env["DATABASE_URL"]) return;
  try {
    await Promise.all([
      addStats(amounts.filter((amount) => !hourlyOnly(amount))),
      addHourlyStats(amounts),
    ]);
  } catch (error) {
    logWarn("cache_warming.stats.record_failed", {
      "exception.message":
        error instanceof Error ? error.message : String(error),
    });
  }
}

const outcome = (
  metric: (typeof OUTCOME_METRICS)[keyof typeof OUTCOME_METRICS],
  name: string,
) => ({ namespace: CACHE_WARMING_NAMESPACE, metric, name, count: 1 });

/** Count one skipped warmup by its `app.cache_warming.skip_reason`. */
export async function recordWarmupSkipped(reason: string): Promise<void> {
  await addCacheCounters([outcome(OUTCOME_METRICS.skipped, reason)]);
}

/** Count one opened or manually closed breaker of a provider. */
export async function recordBreakerEvent(
  provider: string,
  event: "opened" | "closed",
): Promise<void> {
  await addCacheCounters([
    outcome(
      event === "opened"
        ? OUTCOME_METRICS.breakerOpened
        : OUTCOME_METRICS.breakerClosed,
      provider,
    ),
  ]);
}

/** Prompt cache counters of the agent model calls of one run. */
export interface ModelCacheCounter {
  /** Add the usage of one finished agent model call. */
  add(
    modelId: string,
    usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
  ): void;
  /**
   * Write what was added since the last write, in one batch, to the hour
   * that the write happens in. Call it once when the run ends.
   */
  write(): Promise<void>;
}

/**
 * Create the prompt cache counter of one agent run. It adds up in memory, so
 * a run writes its counters once instead of on each model call.
 */
export function createModelCacheCounter(): ModelCacheCounter {
  const totals = new Map<string, Map<string, number>>();
  return {
    add(modelId, usage) {
      const counts = {
        [MODEL_CACHE_METRICS.calls]: 1,
        [MODEL_CACHE_METRICS.inputTokens]:
          usage.input + usage.cacheRead + usage.cacheWrite,
        [MODEL_CACHE_METRICS.cacheWriteTokens]: usage.cacheWrite,
        [MODEL_CACHE_METRICS.cacheReadTokens]: usage.cacheRead,
        [MODEL_CACHE_METRICS.fullRewrites]: isFullRewrite(usage) ? 1 : 0,
      };
      const model = totals.get(modelId) ?? new Map<string, number>();
      totals.set(modelId, model);
      for (const [metric, count] of Object.entries(counts)) {
        model.set(metric, (model.get(metric) ?? 0) + count);
      }
    },
    async write() {
      const amounts = [...totals].flatMap(([name, model]) =>
        [...model].map(([metric, count]) => ({
          namespace: MODEL_CACHE_NAMESPACE,
          metric,
          name,
          count,
        })),
      );
      totals.clear();
      await addCacheCounters(amounts);
    },
  };
}

type Counter = Pick<Stat, "count" | "metric" | "name" | "namespace">;

const sumOf = (
  stats: readonly Counter[],
  namespace: string,
  metric: string,
): number =>
  stats
    .filter((stat) => stat.namespace === namespace && stat.metric === metric)
    .reduce((total, stat) => total + stat.count, 0);

// Sums of one cache warming metric by counter name.
const byName = (
  stats: readonly Counter[],
  metric: string,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const stat of stats) {
    if (stat.namespace !== CACHE_WARMING_NAMESPACE || stat.metric !== metric) {
      continue;
    }
    counts[stat.name] = (counts[stat.name] ?? 0) + stat.count;
  }
  return counts;
};

/** Prompt cache totals of agent model calls, with their ratios. */
export interface ModelCacheTotals {
  calls: number;
  fullRewrites: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Cache write tokens over input tokens. Null with no input. */
  writeShare: number | null;
  /** Full rewrites over calls. Null with no calls. */
  fullRewriteRate: number | null;
}

/** Sum the prompt cache counters of these stats over all models. */
export function modelCacheTotals(stats: readonly Counter[]): ModelCacheTotals {
  const sum = (metric: string) => sumOf(stats, MODEL_CACHE_NAMESPACE, metric);
  const calls = sum(MODEL_CACHE_METRICS.calls);
  const fullRewrites = sum(MODEL_CACHE_METRICS.fullRewrites);
  const inputTokens = sum(MODEL_CACHE_METRICS.inputTokens);
  const cacheWriteTokens = sum(MODEL_CACHE_METRICS.cacheWriteTokens);
  return {
    calls,
    fullRewrites,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens: sum(MODEL_CACHE_METRICS.cacheReadTokens),
    writeShare: inputTokens > 0 ? cacheWriteTokens / inputTokens : null,
    fullRewriteRate: calls > 0 ? fullRewrites / calls : null,
  };
}

/** Warmup outcome totals. */
export interface WarmupOutcomeTotals {
  sent: number;
  missed: number;
  warmedRewrites: number;
  skipped: number;
  sentByTurnEnding: Record<string, number>;
  skipReasons: Record<string, number>;
  breakerOpened: number;
  breakerClosed: number;
}

/** Sum the warmup outcome counters of these stats. */
export function warmupOutcomeTotals(
  stats: readonly Counter[],
): WarmupOutcomeTotals {
  const sum = (metric: string) => sumOf(stats, CACHE_WARMING_NAMESPACE, metric);
  return {
    sent: sum(OUTCOME_METRICS.sent),
    missed: sum(OUTCOME_METRICS.missed),
    warmedRewrites: sum(OUTCOME_METRICS.warmedRewrites),
    skipped: sum(OUTCOME_METRICS.skipped),
    sentByTurnEnding: byName(stats, OUTCOME_METRICS.sent),
    skipReasons: byName(stats, OUTCOME_METRICS.skipped),
    breakerOpened: sum(OUTCOME_METRICS.breakerOpened),
    breakerClosed: sum(OUTCOME_METRICS.breakerClosed),
  };
}
