import type { CacheEntry, PluginCache } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { withLock } from "@/chat/state/locks";

const MAX_CACHE_KEY_LENGTH = 512;
// A caller that waits longer than this loads the value itself.
const LOAD_WAIT_MS = 10_000;

interface StoredEntry<T> {
  value: T;
}

/**
 * Create a cache in the state adapter under `junior:cache:{namespace}:`.
 * Entries are wrapped, so `null` and `false` values are cache hits.
 */
export function createCache(
  state: StateAdapter,
  namespace: string,
): PluginCache {
  return {
    async getOrLoad<T>(
      key: string,
      load: () => Promise<CacheEntry<T>>,
      options?: { refresh?: boolean },
    ): Promise<T> {
      if (!key.trim()) throw new Error("Cache key is required");
      if (key.length > MAX_CACHE_KEY_LENGTH) {
        throw new Error("Cache key exceeds the maximum length");
      }
      const cacheKey = `junior:cache:${namespace}:${key}`;
      const cached = async () =>
        options?.refresh
          ? undefined
          : ((await state.get<StoredEntry<T>>(cacheKey)) ?? undefined);

      await state.connect();
      const hit = await cached();
      if (hit) return hit.value;

      const attempt = await withLock(
        state,
        `${cacheKey}:load`,
        async () => {
          const loadedMeanwhile = await cached();
          if (loadedMeanwhile) return loadedMeanwhile.value;
          const entry = await load();
          if (entry.ttlMs !== undefined) {
            if (!(entry.ttlMs > 0)) {
              throw new Error("Cache ttlMs must be positive");
            }
            await state.set(cacheKey, { value: entry.value }, entry.ttlMs);
          }
          return entry.value;
        },
        { keepAlive: true, waitMs: LOAD_WAIT_MS },
      );
      if (attempt.acquired) return attempt.value;
      // The cache only saves work, so a stuck load must not block this caller.
      return (await load()).value;
    },
  };
}
