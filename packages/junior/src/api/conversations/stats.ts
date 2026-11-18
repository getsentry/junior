import * as z from "zod";
import type { StateAdapter } from "chat";
import { logException } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { cacheKeyPrefix, createCache } from "@/chat/state/cache";
import { withLock } from "@/chat/state/locks";
import type { WaitUntilFn } from "@/handlers/types";
import { readConversationStatsFromSql } from "./stats.query";
import { conversationStatsReportSchema } from "../schema/conversation-stats";
import type { ConversationStatsReport } from "../schema/conversation-stats";

const CACHE_NAMESPACE = "core";
const CACHE_KEY = "conversation-stats";
const FRESH_MS = 5 * 60_000;
// After this, a request reads the stats again before it answers.
const KEEP_MS = 60 * 60_000;
const RELOAD_WAIT_MS = 10_000;

const cachedStatsSchema = z
  .object({
    refreshAtMs: z.number(),
    report: conversationStatsReportSchema,
  })
  .strict();

type CachedStats = z.infer<typeof cachedStatsSchema>;

async function loadCachedStats() {
  const report = conversationStatsReportSchema.parse(
    await readConversationStatsFromSql(),
  );
  return {
    ttlMs: KEEP_MS,
    value: { refreshAtMs: Date.now() + FRESH_MS, report },
  };
}

/**
 * Reload the report under one lock. A caller that gets the lock after
 * another reload first reads the entry that it wrote.
 */
async function reloadCachedStats(
  state: StateAdapter,
  usable: (stats: CachedStats) => boolean,
  waitMs: number,
) {
  const cache = createCache(state, CACHE_NAMESPACE);
  return await withLock(
    state,
    `${cacheKeyPrefix(CACHE_NAMESPACE)}${CACHE_KEY}:reload`,
    async () => {
      const current = cachedStatsSchema.safeParse(
        await cache.getOrLoad(CACHE_KEY, loadCachedStats),
      );
      if (current.success && usable(current.data)) return current.data;
      return await cache.getOrLoad<CachedStats>(CACHE_KEY, loadCachedStats, {
        refresh: true,
      });
    },
    { waitMs },
  );
}

async function refreshCachedStats(state: StateAdapter): Promise<void> {
  try {
    // A request that finds a reload running keeps the stale report.
    await reloadCachedStats(
      state,
      (stats) => Date.now() < stats.refreshAtMs,
      0,
    );
  } catch (error) {
    logException(error, "conversation_stats.refresh.failed");
  }
}

/**
 * Load aggregate conversation stats from durable SQL records. A cached report
 * is served for up to an hour. After five minutes, a request also starts a
 * background refresh.
 */
export async function readConversationStats(options: {
  waitUntil: WaitUntilFn;
}): Promise<ConversationStatsReport> {
  const state = getStateAdapter();
  const cached = cachedStatsSchema.safeParse(
    await createCache(state, CACHE_NAMESPACE).getOrLoad(
      CACHE_KEY,
      loadCachedStats,
    ),
  );
  let stats: CachedStats;
  if (cached.success) {
    stats = cached.data;
  } else {
    // An entry from an older report shape is reloaded once for all callers.
    const reload = await reloadCachedStats(state, () => true, RELOAD_WAIT_MS);
    // The cache only saves work, so a stuck reload must not block this caller.
    stats = reload.acquired ? reload.value : (await loadCachedStats()).value;
  }
  if (Date.now() >= stats.refreshAtMs) {
    options.waitUntil(() => refreshCachedStats(state));
  }
  return stats.report;
}
