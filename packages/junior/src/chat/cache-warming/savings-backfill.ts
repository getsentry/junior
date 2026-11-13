/**
 * One-time fill of the cache warming savings counters from stored
 * Conversation history.
 *
 * Live recording (`savings.ts`) counts only idle periods that end after it is
 * deployed. This replays the stored model calls of the last
 * `SAVINGS_BACKFILL_DAYS` with the same rules, so the System page has history
 * from the first deploy. It writes only days before the first day with
 * counters, so it never adds to a day that live recording wrote.
 *
 * The heartbeat runs it. Only one run claims it. A completed run marks the
 * install as done and never runs again, also when it stopped on its time
 * budget or skipped a batch that the statement timeout canceled.
 */
import { getChatConfig } from "@/chat/config";
import { logInfo, withSpan } from "@/chat/logging";
import { resolveGatewayModel } from "@/chat/pi/client";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  BACKFILL_BUDGET_MS,
  scanIdlePeriods,
  type ReplayedIdlePeriod,
} from "./backfill";
import { MINUTE_MS } from "./model";
import { providerCacheTtlMs } from "./request";
import {
  addBackfilledSavings,
  idlePeriodSavings,
  type BackfilledSavings,
} from "./savings";

// Holds "running" while a run claims it, then "done" with no TTL.
const BACKFILL_KEY = "junior:cache_warming:backfill:savings:v1";
// A run that fails or is stopped before it marks the install as done holds
// the claim for this long. Then a later heartbeat tries again.
const BACKFILL_CLAIM_TTL_MS = 60 * MINUTE_MS;
// The longest range of the System page.
const SAVINGS_BACKFILL_DAYS = 90;

// Count the period as live recording would when the stored call ended it. It
// prices the period with the model of that call, as live recording prices it
// with the model of the next request. A model that the gateway does not know
// has no prices, so its periods do not count.
function savingsOf(period: ReplayedIdlePeriod): BackfilledSavings | undefined {
  const modelId = period.next?.modelId;
  if (!period.next || !modelId) return undefined;
  const ttlMs = providerCacheTtlMs(modelId);
  if (ttlMs === undefined) return undefined;
  let cost: { cacheRead: number; cacheWrite: number };
  try {
    cost = resolveGatewayModel(modelId).cost;
  } catch {
    return undefined;
  }
  const savings = idlePeriodSavings({
    cacheTtlMs: ttlMs,
    gapMs: period.gapMs,
    prefixTokens: period.prefixTokens,
    cacheRead: period.next.cacheRead,
    cacheWrite: period.next.cacheWrite,
    cacheReadPrice: cost.cacheRead,
    cacheWritePrice: cost.cacheWrite,
  });
  return savings
    ? { endedAtMs: period.sinceMs + period.gapMs, modelId, savings }
    : undefined;
}

/**
 * Fill the cache warming savings counters from stored history, once per
 * install. The heartbeat calls it each minute. After a run completes, a call
 * makes one state request and returns.
 */
export async function backfillCacheWarmingSavings(args: {
  nowMs: number;
  budgetMs?: number;
}): Promise<void> {
  if (!getChatConfig().cacheWarmingEnabled) return;
  const state = getStateAdapter();
  await state.connect();
  if (
    !(await state.setIfNotExists(
      BACKFILL_KEY,
      "running",
      BACKFILL_CLAIM_TTL_MS,
    ))
  ) {
    return;
  }
  await withSpan(
    "cache_warming.savings_backfill",
    "cache_warming.backfill",
    {},
    async (setSpanAttributes) => {
      const { periods, scanned, canceledBatches, budgetExceeded } =
        await scanIdlePeriods({
          windowStartMs:
            args.nowMs - SAVINGS_BACKFILL_DAYS * 24 * 60 * MINUTE_MS,
          nowMs: args.nowMs,
          budgetMs: args.budgetMs ?? BACKFILL_BUDGET_MS,
        });
      const logAttributes = {
        "app.cache_warming.backfill.conversation_count": scanned,
        "app.cache_warming.backfill.canceled_batch_count": canceledBatches,
        "app.cache_warming.backfill.budget_exceeded": budgetExceeded,
      };
      // Only canceled queries: no history was read. The claim expires, and a
      // later heartbeat tries again.
      if (scanned === 0 && canceledBatches > 0) {
        logInfo("cache_warming.savings_backfill.not_completed", logAttributes);
        setSpanAttributes({
          ...logAttributes,
          "app.cache_warming.backfill.outcome": "not_completed",
        });
        return;
      }
      const counted = periods.flatMap((period) => savingsOf(period) ?? []);
      const days = await addBackfilledSavings(counted, args.nowMs);
      await state.set(BACKFILL_KEY, "done");
      const completed = {
        ...logAttributes,
        "app.cache_warming.backfill.idle_period_count": counted.length,
        "app.cache_warming.backfill.day_count": days.length,
      };
      logInfo("cache_warming.savings_backfill.completed", completed);
      setSpanAttributes({
        ...completed,
        "app.cache_warming.backfill.outcome": "completed",
      });
    },
  );
}
