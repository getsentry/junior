import { createHash } from "node:crypto";
import type { AgentPluginState } from "@sentry/junior-plugin-api";
import { getStateAdapter } from "@/chat/state/adapter";

const MAX_PLUGIN_STATE_KEY_LENGTH = 512;

export interface PluginStateOptions {
  legacyStatePrefixes?: string[];
}

function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function pluginStateKey(plugin: string, key: string): string {
  return `junior:plugin_state:${hashKeyPart(plugin)}:${hashKeyPart(key)}`;
}

function validatePluginStateKey(key: string): void {
  if (!key.trim()) {
    throw new Error("Plugin state key is required");
  }
  if (key.length > MAX_PLUGIN_STATE_KEY_LENGTH) {
    throw new Error("Plugin state key exceeds the maximum length");
  }
}

function legacyStateKey(
  key: string,
  options: PluginStateOptions | undefined,
): string | undefined {
  for (const prefix of options?.legacyStatePrefixes ?? []) {
    const trimmed = prefix.trim();
    if (!trimmed) {
      continue;
    }
    if (key === trimmed || key.startsWith(`${trimmed}:`)) {
      return key;
    }
  }
  return undefined;
}

/** Create a durable state namespace scoped to one plugin. */
export function createPluginState(
  plugin: string,
  options?: PluginStateOptions,
): AgentPluginState {
  return {
    async delete(key) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      await state.delete(pluginStateKey(plugin, key));
      const legacyKey = legacyStateKey(key, options);
      if (legacyKey) {
        await state.delete(legacyKey);
      }
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      const value = await state.get<T>(pluginStateKey(plugin, key));
      if (value !== null && value !== undefined) {
        return value;
      }
      const legacyKey = legacyStateKey(key, options);
      return legacyKey
        ? ((await state.get<T>(legacyKey)) ?? undefined)
        : undefined;
    },
    async set(key, value, ttlMs) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      await state.set(pluginStateKey(plugin, key), value, ttlMs);
    },
    async setIfNotExists(key, value, ttlMs) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      const legacyKey = legacyStateKey(key, options);
      if (legacyKey) {
        const existing = await state.get(legacyKey);
        if (existing !== null && existing !== undefined) {
          return false;
        }
      }
      return await state.setIfNotExists(
        pluginStateKey(plugin, key),
        value,
        ttlMs,
      );
    },
    async withLock(key, ttlMs, callback) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      const lockKey =
        legacyStateKey(key, options) ?? pluginStateKey(plugin, key);
      const lock = await state.acquireLock(lockKey, ttlMs);
      if (!lock) {
        throw new Error(`Could not acquire plugin state lock for ${key}`);
      }

      try {
        return await callback();
      } finally {
        await state.releaseLock(lock);
      }
    },
  };
}
