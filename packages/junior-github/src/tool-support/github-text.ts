import type {
  PluginToolDefinition,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";

type Users = ToolRegistrationHookContext["users"];

async function mapStrings(
  value: unknown,
  replace: (text: string) => Promise<string>,
): Promise<unknown> {
  if (typeof value === "string") return await replace(value);
  if (Array.isArray(value)) {
    return await Promise.all(value.map((item) => mapStrings(item, replace)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      await Promise.all(
        Object.entries(value).map(async ([key, item]) => [
          key,
          await mapStrings(item, replace),
        ]),
      ),
    );
  }
  return value;
}

/**
 * Make every GitHub tool send GitHub text. The model reads Slack threads, so
 * it can copy Slack mention syntax into a title, body, or comment. GitHub
 * shows that syntax as literal text, so core rewrites it before the tool
 * runs: a Slack user becomes their linked GitHub `@login`, or their name.
 */
export function withGitHubText(
  tools: Record<string, PluginToolDefinition>,
  users: Users,
): Record<string, PluginToolDefinition> {
  // Slack syntax always starts with `<`, so most strings need no lookup.
  const replace = async (text: string) =>
    text.includes("<")
      ? await users.replaceSlackMentions(text, "github")
      : text;
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const execute = tool.execute;
      if (!execute) return [name, tool];
      // Keep prototype methods and their receiver on the tool instance.
      const wrapped: PluginToolDefinition = Object.create(tool);
      wrapped.execute = async (input, options) =>
        await execute.call(tool, await mapStrings(input, replace), options);
      return [name, wrapped];
    }),
  );
}
