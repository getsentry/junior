import type { PluginToolDefinition } from "@sentry/junior-plugin-api";

/**
 * Make every GitHub tool send GitHub text. The model reads Slack threads, so
 * it can copy Slack mention syntax into a title, body, or comment. GitHub
 * shows that syntax as literal text, so core rewrites it before the tool
 * runs: a Slack user becomes their linked GitHub `@login`, or their name.
 */
export function withGitHubText(
  tools: Record<string, PluginToolDefinition>,
): Record<string, PluginToolDefinition> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      const wrapped: PluginToolDefinition = {
        ...tool,
        execute: async (input, options, ctx) =>
          await execute.call(
            tool,
            await ctx.users.replaceSlackMentions(input, "github"),
            options,
            ctx,
          ),
      };
      return [name, wrapped];
    }),
  );
}
