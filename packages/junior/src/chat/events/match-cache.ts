import { AsyncLocalStorage } from "node:async_hooks";

// One token per plugin route request. Caches key their entries by it, so
// nothing read in one request is reused by another.
const requestScope = new AsyncLocalStorage<object>();

/** Run `callback` with a fresh request scope for event match reads. */
export function runWithEventMatchCache<T>(callback: () => T): T {
  return requestScope.run({}, callback);
}

/**
 * Build a read-through cache for event match checks. Inside a request scope,
 * the same key loads once. Outside one, every call loads fresh. Use it only for
 * `hasMatch` style checks; delivery must keep reading current state.
 */
export function createEventMatchCache<T>(): (
  key: string,
  load: () => Promise<T>,
) => Promise<T> {
  const caches = new WeakMap<object, Map<string, Promise<T>>>();
  return async (key, load) => {
    const token = requestScope.getStore();
    if (!token) return await load();
    let cache = caches.get(token);
    if (!cache) {
      cache = new Map();
      caches.set(token, cache);
    }
    const existing = cache.get(key);
    if (existing) return await existing;
    const pending = load();
    const entries = cache;
    entries.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      // Do not keep a failed read; a later check retries it.
      entries.delete(key);
      throw error;
    }
  };
}
