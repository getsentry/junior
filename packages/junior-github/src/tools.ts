import type {
  PluginToolDefinition,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { createGitHubIssueTool } from "./tools/create-issue.js";
import { createGitHubPullRequestTool } from "./tools/create-pull-request.js";

/** Build the GitHub plugin's runtime tools from their per-tool modules. */
export function createGitHubTools(
  ctx: ToolRegistrationHookContext,
): Record<string, PluginToolDefinition> {
  return {
    createIssue: createGitHubIssueTool(ctx),
    createPullRequest: createGitHubPullRequestTool(ctx),
  };
}
