export interface PluginState {
  delete(key: string): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  /**
   * Run `callback` only when no other caller holds `key`. A held lock is a
   * normal outcome, so it returns `{ acquired: false }` instead of throwing.
   */
  withLock<T>(
    key: string,
    ttlMs: number,
    callback: () => Promise<T>,
  ): Promise<PluginLockResult<T>>;
}

/** Outcome of `PluginState.withLock`. */
export type PluginLockResult<T> =
  | { acquired: false }
  | { acquired: true; value: T };

export interface PluginReadState {
  get<T = unknown>(key: string): Promise<T | undefined>;
}
