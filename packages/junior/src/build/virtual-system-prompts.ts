import type { Nitro } from "nitro/types";
import type { PluginRegistration } from "@sentry/junior-plugin-api";

/**
 * Inject `#junior/system-prompts`: the system prompt sections of every
 * platform and Prompt mode, built from `loadPlugins()`. Nitro renders it at
 * build, so plugin `systemPrompt` hooks run only there, and a hook that fails
 * fails the build.
 */
export function injectVirtualSystemPrompts(
  nitro: Nitro,
  loadPlugins: () => Promise<PluginRegistration[]>,
): void {
  nitro.options.virtual["#junior/system-prompts"] = async () => {
    // Load the prompt code only when Nitro renders the module.
    const { buildSystemPromptTable } = await import("@/chat/system-prompt");
    const table = await buildSystemPromptTable(await loadPlugins());
    return `export const systemPrompts = ${JSON.stringify(table)};`;
  };
}
