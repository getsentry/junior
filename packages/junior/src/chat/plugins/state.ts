import { createHash } from "node:crypto";
import type { PluginState } from "@sentry/junior-plugin-api";
import type { StateAdapter } from "chat";
import { getStateAdapter } from "@/chat/state/adapter";

const MAX_PLUGIN_STATE_KEY_LENGTH = 512;

function hashKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function pluginStateKey(plugin: string, key: string): string {
  const pluginPrefix = `junior:${plugin}`;
  if (key === pluginPrefix || key.startsWith(`${pluginPrefix}:`)) {
    return key;
  }
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

/** Create a durable state namespace scoped to one plugin. */
export function createPluginState(
  plugin: string,
  adapter?: StateAdapter,
): PluginState {
  const getAdapter = (): StateAdapter => adapter ?? getStateAdapter();
  return {
    async delete(key) {
      validatePluginStateKey(key);
      const state = getAdapter();
      await state.connect();
      await state.delete(pluginStateKey(plugin, key));
    },
    async get<T = unknown>(key: string): Promise<T | undefined> {
      validatePluginStateKey(key);
      const state = getAdapter();
      await state.connect();
      const value = await state.get<T>(pluginStateKey(plugin, key));
      return value ?? undefined;
    },
    async set(key, value, ttlMs) {
      validatePluginStateKey(key);
      const state = getAdapter();
      await state.connect();
      await state.set(pluginStateKey(plugin, key), value, ttlMs);
    },
    async setIfNotExists(key, value, ttlMs) {
      validatePluginStateKey(key);
      const state = getAdapter();
      await state.connect();
      return await state.setIfNotExists(
        pluginStateKey(plugin, key),
        value,
        ttlMs,
      );
    },
    async withLock(key, ttlMs, callback) {
      validatePluginStateKey(key);
      const state = getAdapter();
      await state.connect();
      const lockKey = pluginStateKey(plugin, key);
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
