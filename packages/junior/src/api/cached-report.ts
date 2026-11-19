import * as z from "zod";
import type { StateAdapter } from "chat";
import type { LogEventName } from "@/chat/log-event-name";
import { logException, withSpan } from "@/chat/logging";
import { getStateAdapter } from "@/chat/state/adapter";
import { cacheKeyPrefix, createCache } from "@/chat/state/cache";
import { withLock } from "@/chat/state/locks";
import type { WaitUntilFn } from "@/handlers/types";

const CACHE_NAMESPACE = "core";
const FRESH_MS = 5 * 60_000;
// After this, a request reads the report again before it answers.
const KEEP_MS = 60 * 60_000;
const RELOAD_WAIT_MS = 10_000;

/**
 * Create a reader for one report that is the same for every viewer. A cached
 * report is served for up to an hour. After five minutes, a request also
 * starts a background refresh.
 */
export function createCachedReport<T, const N extends string>(source: {
  key: string;
  read: () => Promise<T>;
  refreshFailedEvent: LogEventName<N>;
  schema: z.ZodType<T>;
}): (options: { waitUntil: WaitUntilFn }) => Promise<T> {
  const cachedSchema = z
    .object({ refreshAtMs: z.number(), report: source.schema })
    .strict();
  type Cached = z.infer<typeof cachedSchema>;

  const load = async () => ({
    ttlMs: KEEP_MS,
    value: {
      refreshAtMs: Date.now() + FRESH_MS,
      report: source.schema.parse(await source.read()),
    },
  });

  /**
   * Reload the report under one lock. A caller that gets the lock after
   * another reload first reads the entry that it wrote.
   */
  const reload = async (
    state: StateAdapter,
    usable: (cached: Cached) => boolean,
    waitMs: number,
  ) => {
    const cache = createCache(state, CACHE_NAMESPACE);
    return await withLock(
      state,
      `${cacheKeyPrefix(CACHE_NAMESPACE)}${source.key}:reload`,
      async () => {
        const current = cachedSchema.safeParse(
          await cache.getOrLoad(source.key, load),
        );
        if (current.success && usable(current.data)) return current.data;
        return await cache.getOrLoad<Cached>(source.key, load, {
          refresh: true,
        });
      },
      { waitMs },
    );
  };

  const refresh = (state: StateAdapter): Promise<void> =>
    withSpan(
      source.key,
      "cache.refresh",
      {},
      async () => {
        try {
          // A request that finds a reload running keeps the stale report.
          await reload(state, (cached) => Date.now() < cached.refreshAtMs, 0);
        } catch (error) {
          logException(error, source.refreshFailedEvent);
        }
      },
      { "cache.key": source.key },
    );

  return ({ waitUntil }) =>
    // Sentry's cache convention: one `cache.get` span per read, named by key.
    withSpan(
      source.key,
      "cache.get",
      {},
      async (setSpanAttributes) => {
        const state = getStateAdapter();
        let hit = true;
        const loadOnMiss = () => {
          hit = false;
          return load();
        };
        const parsed = cachedSchema.safeParse(
          await createCache(state, CACHE_NAMESPACE).getOrLoad(
            source.key,
            loadOnMiss,
          ),
        );
        let cached: Cached;
        if (parsed.success) {
          cached = parsed.data;
        } else {
          hit = false;
          // An entry from an older report shape is reloaded once for all callers.
          const reloaded = await reload(state, () => true, RELOAD_WAIT_MS);
          // The cache only saves work, so a stuck reload must not block this caller.
          cached = reloaded.acquired ? reloaded.value : (await load()).value;
        }
        const now = Date.now();
        const stale = now >= cached.refreshAtMs;
        // Reports are small, so serializing the entry again to size it is cheap.
        setSpanAttributes({
          "cache.hit": hit,
          "cache.item_size": Buffer.byteLength(JSON.stringify(cached)),
          "app.cache.stale": stale,
          "app.cache.age_ms": now - (cached.refreshAtMs - FRESH_MS),
        });
        if (stale) {
          waitUntil(() => refresh(state));
        }
        return cached.report;
      },
      { "cache.key": source.key },
    );
}
