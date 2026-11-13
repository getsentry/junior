import type {
  PluginToolDefinition,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";

/**
 * Make every GitHub tool send GitHub text. The model reads Slack threads, so
 * it can copy Slack mention syntax into a title, body, or comment. GitHub
 * shows that syntax as literal text, so core rewrites it before the tool
 * runs: a Slack user becomes their linked GitHub `@login`, or their name.
 */
export function withGitHubText(
  tools: Record<string, PluginToolDefinition>,
  users: ToolRegistrationHookContext["users"],
): Record<string, PluginToolDefinition> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      // Keep prototype methods and their receiver on the tool instance.
      const wrapped: PluginToolDefinition = Object.create(tool);
      wrapped.execute = async (input, options) =>
        await execute.call(
          tool,
          await users.replaceSlackMentions(input, "github"),
          options,
        );
      return [name, wrapped];
    }),
  );
}
