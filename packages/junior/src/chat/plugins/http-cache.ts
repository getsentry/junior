import type { PluginHttpCache } from "@sentry/junior-plugin-api";
import { readThroughHttpCache } from "@/chat/egress/http-cache";

/**
 * Create the HTTP cache of one plugin's reads with tokens that it minted.
 * Its scopes are its own: they never name an egress credential or another
 * plugin's entry.
 */
export function createPluginHttpCache(plugin: string): PluginHttpCache {
  return {
    async fetch(input) {
      return await readThroughHttpCache({
        request: new Request(input.url),
        scope: `plugin:${plugin}:${input.scope}`,
        send: input.send,
        // A webhook read decides access, such as a collaborator role, so
        // it never gets an answer that its own request did not confirm.
        staleIfError: false,
        ttlMs: input.ttlMs,
      });
    },
  };
}
