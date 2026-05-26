import { createHash } from "node:crypto";
import type { AgentPluginState } from "@sentry/junior-plugin-api";
import { getStateAdapter } from "@/chat/state/adapter";

const MAX_PLUGIN_STATE_KEY_LENGTH = 512;

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

/** Create a durable state namespace scoped to one trusted plugin. */
export function createPluginState(plugin: string): AgentPluginState {
  return {
    async delete(key) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      await state.delete(pluginStateKey(plugin, key));
    },
    async get(key) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      return (await state.get(pluginStateKey(plugin, key))) ?? undefined;
    },
    async set(key, value, ttlMs) {
      validatePluginStateKey(key);
      const state = getStateAdapter();
      await state.connect();
      await state.set(pluginStateKey(plugin, key), value, ttlMs);
    },
  };
}
