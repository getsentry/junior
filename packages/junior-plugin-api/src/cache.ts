/** A loaded value and how long to cache it. */
export interface CacheEntry<T> {
  /** Omit to return the value without caching it, such as for an incomplete response. */
  ttlMs?: number;
  /** Must survive JSON serialization. */
  value: T;
}

/**
 * Short-lived copies of values that are slow or costly to load, such as
 * provider API reads. Junior can drop an entry at any time. A lost entry only
 * costs a reload, so never keep data here that Junior must not lose. Use
 * `PluginState` for that.
 */
export interface PluginCache {
  /**
   * Return the cached value for `key`, or call `load` and cache its result.
   * Concurrent callers share one load. A load that throws is not cached.
   * `refresh` ignores the cached value and replaces it.
   */
  getOrLoad<T>(
    key: string,
    load: () => Promise<CacheEntry<T>>,
    options?: { refresh?: boolean },
  ): Promise<T>;
}
