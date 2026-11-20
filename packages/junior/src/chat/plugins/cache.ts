import type { PluginCache } from "@sentry/junior-plugin-api";
import { createCache } from "@/chat/state/cache";
import { getStateAdapter } from "@/chat/state/adapter";

/** Create the cache scoped to one plugin. */
export function createPluginCache(plugin: string): PluginCache {
  return {
    async getOrLoad(key, load, options) {
      return await createCache(getStateAdapter(), `plugin:${plugin}`).getOrLoad(
        key,
        load,
        options,
      );
    },
  };
}
