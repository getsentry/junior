import type {
  PluginToolDefinition,
  PluginToolsHook,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";

const NO_TURN = new Proxy({} as ToolRegistrationHookContext, {
  get() {
    throw new Error("Plugin tool definitions must not read Turn context.");
  },
});

/**
 * Build a plugin `tools` hook from one function that returns complete tools.
 * `definitions()` calls it with no Turn, so it fails if a definition reads
 * Turn context.
 */
export function pluginToolsHook(
  build: (
    ctx: ToolRegistrationHookContext,
  ) => Record<string, PluginToolDefinition>,
): PluginToolsHook {
  return { definitions: () => build(NO_TURN), bind: build };
}
