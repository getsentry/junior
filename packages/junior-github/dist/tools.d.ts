import type { PluginToolDefinition, ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
/** Build the GitHub plugin's runtime tools from their per-tool modules. */
export declare function createGitHubTools(ctx: ToolRegistrationHookContext): Record<string, PluginToolDefinition>;
