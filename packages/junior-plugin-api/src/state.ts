/** One renewable lease in a plugin's durable state namespace. */
export interface PluginLease {
  readonly expiresAt: number;
  release(): Promise<void>;
  renew(ttlMs: number): Promise<boolean>;
}

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

/** Durable state operations available only to HTTP route plugins. */
export interface PluginRouteState extends PluginState {
  acquireLease(key: string, ttlMs: number): Promise<PluginLease | undefined>;
  appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void>;
  getList<T = unknown>(key: string): Promise<T[]>;
}

export interface PluginReadState {
  get<T = unknown>(key: string): Promise<T | undefined>;
}
