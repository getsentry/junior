import type { MigrationStateV1 } from "@sentry/junior-migrations";
import type { StateAdapter } from "chat";
import {
  createPluginState,
  pluginStateKey,
  validatePluginStateKey,
} from "@/chat/plugins/state";

/** Project host state onto the permanent v1 migration API for one plugin. */
export function createPluginMigrationStateV1(
  plugin: string,
  stateAdapter: StateAdapter,
): MigrationStateV1 {
  const pluginState = createPluginState(plugin, stateAdapter);
  const stateKey = (key: string): string => {
    validatePluginStateKey(key);
    return pluginStateKey(plugin, key);
  };

  return {
    acquireLock: async (key, ttlMs) => {
      await stateAdapter.connect();
      return await stateAdapter.acquireLock(stateKey(key), ttlMs);
    },
    appendToList: async (key, value, options) => {
      await stateAdapter.connect();
      await stateAdapter.appendToList(stateKey(key), value, options);
    },
    connect: async () => {
      await stateAdapter.connect();
    },
    delete: async (key) => {
      await pluginState.delete(key);
    },
    get: async <T>(key: string) => await pluginState.get<T>(key),
    getList: async <T>(key: string) => {
      await stateAdapter.connect();
      return await stateAdapter.getList<T>(stateKey(key));
    },
    releaseLock: async (lock) => {
      await stateAdapter.releaseLock(lock);
    },
    set: async (key, value, ttlMs) => {
      await pluginState.set(key, value, ttlMs);
    },
    setIfNotExists: async (key, value, ttlMs) =>
      await pluginState.setIfNotExists(key, value, ttlMs),
  };
}
