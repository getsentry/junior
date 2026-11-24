import type { PluginCache } from "@sentry/junior-plugin-api";
import { createCache } from "@/chat/state/cache";
import { getStateAdapter } from "@/chat/state/adapter";

/** Create the cache scoped to one plugin. */
export function createPluginCache(plugin: string): PluginCache {
  const cache = () => createCache(getStateAdapter(), `plugin:${plugin}`);
  return {
    async get(key) {
      return await cache().get(key);
    },
    async getOrLoad(key, load, options) {
      return await cache().getOrLoad(key, load, options);
    },
    async update(key, next) {
      await cache().update(key, next);
    },
    async delete(key) {
      await cache().delete(key);
    },
  };
}
