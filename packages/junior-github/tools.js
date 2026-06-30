import { createGitHubIssueTool } from "./tools/create-issue.js";

/** Build the GitHub plugin's runtime tools from their per-tool modules. */
export function createGitHubTools(ctx) {
  return {
    createIssue: createGitHubIssueTool(ctx),
  };
}
