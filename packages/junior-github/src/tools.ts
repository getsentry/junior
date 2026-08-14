import type {
  PluginToolDefinition,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { createGitHubCloneRepositoryTool } from "./tools/clone-repository.js";
import { createGitHubIssueTool } from "./tools/create-issue.js";
import { createGitHubGetDeploymentTool } from "./tools/get-deployment.js";
import { createGitHubPullRequestTool } from "./tools/create-pull-request.js";
import { createGitHubGetPullRequestTool } from "./tools/get-pull-request.js";
import { createGitHubGetReleaseTool } from "./tools/get-release.js";
import { createGitHubGetRepositoryTool } from "./tools/get-repository.js";
import { createGitHubUpdateIssueTool } from "./tools/update-issue.js";
import { createGitHubUpdatePullRequestTool } from "./tools/update-pull-request.js";
import { createGitHubResolvePullRequestReviewThreadTool } from "./tools/resolve-pull-request-review-thread.js";

/** Build the GitHub plugin's runtime tools from their per-tool modules. */
export function createGitHubTools(
  ctx: ToolRegistrationHookContext,
  botEmail?: string,
): Record<string, PluginToolDefinition> {
  return {
    cloneRepository: createGitHubCloneRepositoryTool(ctx),
    createIssue: createGitHubIssueTool(ctx),
    createPullRequest: createGitHubPullRequestTool(ctx),
    getDeployment: createGitHubGetDeploymentTool(ctx),
    getPullRequest: createGitHubGetPullRequestTool(ctx),
    getRelease: createGitHubGetReleaseTool(ctx),
    getRepository: createGitHubGetRepositoryTool(ctx),
    resolvePullRequestReviewThread:
      createGitHubResolvePullRequestReviewThreadTool(ctx, botEmail),
    updateIssue: createGitHubUpdateIssueTool(ctx),
    updatePullRequest: createGitHubUpdatePullRequestTool(ctx),
  };
}
