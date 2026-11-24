import { randomUUID } from "node:crypto";
import type { CacheEntry, PluginCache } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { withLock } from "@/chat/state/locks";

const MAX_CACHE_KEY_LENGTH = 512;
// A caller that waits longer than this loads the value itself.
const LOAD_WAIT_MS = 10_000;
// How long a `staleIfError` entry outlives its TTL as the last good value.
const LAST_GOOD_MS = 24 * 60 * 60 * 1000;
// How long a write without the load lock stays marked. A load that runs
// longer than this can still store a value older than that write.
const WRITE_MARK_TTL_MS = 60 * 60 * 1000;

interface StoredEntry<T> {
  /** Set on `staleIfError` entries: after this time, the entry is stale. */
  freshUntilMs?: number;
  value: T;
}

function isFresh(entry: StoredEntry<unknown>): boolean {
  return entry.freshUntilMs === undefined || Date.now() < entry.freshUntilMs;
}

async function storeEntry<T>(
  state: StateAdapter,
  cacheKey: string,
  entry: CacheEntry<T> & { ttlMs: number },
): Promise<void> {
  if (!(entry.ttlMs > 0)) throw new Error("Cache ttlMs must be positive");
  await state.set<StoredEntry<T>>(
    cacheKey,
    entry.staleIfError
      ? { freshUntilMs: Date.now() + entry.ttlMs, value: entry.value }
      : { value: entry.value },
    entry.staleIfError ? entry.ttlMs + LAST_GOOD_MS : entry.ttlMs,
  );
}

function writeMarkKey(cacheKey: string): string {
  return `${cacheKey}:written`;
}

// The load lock keeps a load that started before this write from replacing
// it. Without the lock, the entry goes, so the next read loads it, and the
// mark tells the running load not to keep its older value.
async function writeUnderLoadLock(
  state: StateAdapter,
  cacheKey: string,
  write: (cacheKey: string) => Promise<void>,
): Promise<void> {
  await state.connect();
  const attempt = await withLock(
    state,
    `${cacheKey}:load`,
    async () => await write(cacheKey),
    { keepAlive: true, waitMs: LOAD_WAIT_MS },
  );
  if (attempt.acquired) return;
  await state.set(writeMarkKey(cacheKey), randomUUID(), WRITE_MARK_TTL_MS);
  await state.delete(cacheKey);
}

/** The prefix of every state key of one cache namespace. */
export function cacheKeyPrefix(namespace: string): string {
  return `junior:cache:${namespace}:`;
}

/**
 * Create a cache in the state adapter under `junior:cache:{namespace}:`.
 * Entries are wrapped, so `null` and `false` values are cache hits. A stale
 * `staleIfError` entry is returned when its reload throws, unless the caller
 * asked for `refresh`.
 */
export function createCache(
  state: StateAdapter,
  namespace: string,
): PluginCache {
  const stateKey = (key: string) => {
    if (!key.trim()) throw new Error("Cache key is required");
    if (key.length > MAX_CACHE_KEY_LENGTH) {
      throw new Error("Cache key exceeds the maximum length");
    }
    return `${cacheKeyPrefix(namespace)}${key}`;
  };
  return {
    async getOrLoad<T>(
      key: string,
      load: () => Promise<CacheEntry<T>>,
      options?: { refresh?: boolean },
    ): Promise<T> {
      const cacheKey = stateKey(key);
      const cached = async () =>
        options?.refresh
          ? undefined
          : ((await state.get<StoredEntry<T>>(cacheKey)) ?? undefined);

      await state.connect();
      const hit = await cached();
      if (hit && isFresh(hit)) return hit.value;

      try {
        const attempt = await withLock(
          state,
          `${cacheKey}:load`,
          async () => {
            const loadedMeanwhile = await cached();
            if (loadedMeanwhile && isFresh(loadedMeanwhile)) {
              return loadedMeanwhile.value;
            }
            const mark = await state.get<string>(writeMarkKey(cacheKey));
            const entry = await load();
            if (entry.ttlMs !== undefined) {
              await storeEntry(state, cacheKey, {
                ...entry,
                ttlMs: entry.ttlMs,
              });
              // A write that could not wait for this load came meanwhile.
              // This value is older than it, so the next read loads again.
              const markNow = await state.get<string>(writeMarkKey(cacheKey));
              if ((markNow ?? null) !== (mark ?? null)) {
                await state.delete(cacheKey);
              }
            }
            return entry.value;
          },
          { keepAlive: true, waitMs: LOAD_WAIT_MS },
        );
        if (attempt.acquired) return attempt.value;
        // The cache only saves work, so a stuck load must not block this caller.
        return (await load()).value;
      } catch (error) {
        // Only a stale `staleIfError` entry is still here after its TTL.
        if (hit) return hit.value;
        throw error;
      }
    },
    async update<T>(
      key: string,
      next: (current: T | undefined) => CacheEntry<T> | undefined,
    ): Promise<void> {
      await writeUnderLoadLock(state, stateKey(key), async (cacheKey) => {
        const current = await state.get<StoredEntry<T>>(cacheKey);
        const entry = next(current?.value);
        if (entry?.ttlMs !== undefined) {
          await storeEntry(state, cacheKey, { ...entry, ttlMs: entry.ttlMs });
        }
      });
    },
  };
}
