import type {
  PluginToolDefinition,
  ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { createGitHubReactToIssueTool } from "./tools/react-to-issue.js";
import { createGitHubCloneRepositoryTool } from "./tools/clone-repository.js";
import { createGitHubCommentOnIssueTool } from "./tools/comment-on-issue.js";
import { createGitHubCommentOnPullRequestTool } from "./tools/comment-on-pull-request.js";
import { createGitHubIssueTool } from "./tools/create-issue.js";
import { createGitHubGetDeploymentTool } from "./tools/get-deployment.js";
import { createGitHubGetIssueTool } from "./tools/get-issue.js";
import { createGitHubPullRequestTool } from "./tools/create-pull-request.js";
import type { GitHubPullRequestSubscriptionConfig } from "./events/pull-request.js";
import { createGitHubGetPullRequestTool } from "./tools/get-pull-request.js";
import { createGitHubGetReleaseTool } from "./tools/get-release.js";
import { createGitHubGetRepositoryTool } from "./tools/get-repository.js";
import { createGitHubGetStatusTool } from "./tools/get-status.js";
import { createGitHubUpdateIssueTool } from "./tools/update-issue.js";
import { createGitHubUpdateIssueCommentTool } from "./tools/update-issue-comment.js";
import { createGitHubUpdatePullRequestTool } from "./tools/update-pull-request.js";
import { createGitHubUpdatePullRequestFeedbackTool } from "./tools/update-pull-request-feedback.js";
import { createGitHubResolvePullRequestReviewThreadTool } from "./tools/resolve-pull-request-review-thread.js";
import { createGitHubSubmitPullRequestReviewTool } from "./tools/submit-pull-request-review.js";

/** Opt-ins for GitHub plugin behavior that is still being tested. */
export interface GitHubPluginExperiments {
  /**
   * Check pull request descriptions with the decision model before a create
   * or update, and reject ones with check results, a work log, chat talk, or
   * no reason.
   */
  pullRequestDescriptionChecks?: boolean;
}

/** Build the GitHub plugin's runtime tools from their per-tool modules. */
export function createGitHubTools(
  ctx: ToolRegistrationHookContext,
  botEmail?: string,
  pullRequestSubscription?: GitHubPullRequestSubscriptionConfig,
  experimental: GitHubPluginExperiments = {},
): Record<string, PluginToolDefinition> {
  const descriptionDecider = experimental.pullRequestDescriptionChecks
    ? ctx.decider
    : undefined;
  return {
    reactToIssue: createGitHubReactToIssueTool(ctx.egress),
    cloneRepository: createGitHubCloneRepositoryTool(ctx),
    commentOnIssue: createGitHubCommentOnIssueTool(ctx.egress),
    commentOnPullRequest: createGitHubCommentOnPullRequestTool(ctx.egress),
    createIssue: createGitHubIssueTool(ctx),
    createPullRequest: createGitHubPullRequestTool(
      ctx,
      pullRequestSubscription,
      descriptionDecider,
    ),
    getDeployment: createGitHubGetDeploymentTool(ctx),
    getIssue: createGitHubGetIssueTool(ctx),
    getPullRequest: createGitHubGetPullRequestTool(ctx),
    getRelease: createGitHubGetReleaseTool(ctx),
    getRepository: createGitHubGetRepositoryTool(ctx),
    getStatus: createGitHubGetStatusTool(ctx),
    resolvePullRequestReviewThread:
      createGitHubResolvePullRequestReviewThreadTool(ctx, botEmail),
    submitPullRequestReview: createGitHubSubmitPullRequestReviewTool(
      ctx.egress,
    ),
    updateIssue: createGitHubUpdateIssueTool(ctx),
    updateIssueComment: createGitHubUpdateIssueCommentTool(
      ctx.egress,
      botEmail,
    ),
    updatePullRequest: createGitHubUpdatePullRequestTool(
      ctx,
      descriptionDecider,
    ),
    updatePullRequestFeedback: createGitHubUpdatePullRequestFeedbackTool(
      ctx,
      botEmail,
    ),
  };
}
