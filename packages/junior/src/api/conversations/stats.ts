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

async function refreshCachedStats(state: StateAdapter): Promise<void> {
  try {
    // One refresh at a time. A request that finds one running keeps the
    // stale report.
    await withLock(
      state,
      `${cacheKeyPrefix(CACHE_NAMESPACE)}${CACHE_KEY}:refresh`,
      () =>
        createCache(state, CACHE_NAMESPACE).getOrLoad<CachedStats>(
          CACHE_KEY,
          loadCachedStats,
          { refresh: true },
        ),
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
  const cache = createCache(state, CACHE_NAMESPACE);
  const cached = cachedStatsSchema.safeParse(
    await cache.getOrLoad(CACHE_KEY, loadCachedStats),
  );
  // An entry from an older report shape is reloaded.
  const stats = cached.success
    ? cached.data
    : await cache.getOrLoad<CachedStats>(CACHE_KEY, loadCachedStats, {
        refresh: true,
      });
  if (Date.now() >= stats.refreshAtMs) {
    options.waitUntil(() => refreshCachedStats(state));
  }
  return stats.report;
}
