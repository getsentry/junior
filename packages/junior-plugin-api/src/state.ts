import type { PluginJsonValue } from "./json";

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

/** Append-only plugin bookkeeping tied to the current model-visible session projection. */
export interface PluginSessionStateAppend {
  key: string;
  value: PluginJsonValue;
}

/** Read plugin-scoped session bookkeeping for prompt continuity decisions. */
export interface PluginSessionState {
  list<T = unknown>(
    key: string,
  ): Promise<Array<{ createdAtMs: number; value: T }>>;
}
