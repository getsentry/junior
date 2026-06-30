export interface PluginState {
  delete(key: string): Promise<void>;
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs?: number): Promise<void>;
  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean>;
  withLock<T>(
    key: string,
    ttlMs: number,
    callback: () => Promise<T>,
  ): Promise<T>;
}

export interface PluginReadState {
  get<T = unknown>(key: string): Promise<T | undefined>;
}
