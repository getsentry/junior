/** A loaded value and how long to cache it. */
export interface CacheEntry<T> {
  /** Omit to return the value without caching it, such as for an incomplete response. */
  ttlMs?: number;
  /**
   * Keep the value for a day after its TTL, and return it when a later load
   * throws, such as during a provider outage. Never set it on an answer
   * about access: access must expire with its TTL.
   */
  staleIfError?: boolean;
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
   * Concurrent callers share one load. A load that throws is not cached,
   * and it throws to the caller unless a `staleIfError` value is kept.
   * `refresh` ignores the cached value and replaces it.
   */
  getOrLoad<T>(
    key: string,
    load: () => Promise<CacheEntry<T>>,
    options?: { refresh?: boolean },
  ): Promise<T>;
  /**
   * Drop the cached value of `key`, such as when a provider webhook says
   * that the object changed. The next `getOrLoad` loads it again.
   */
  delete(key: string): Promise<void>;
}
