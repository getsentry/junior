import type { PluginToolDefinition } from "@sentry/junior-plugin-api";
import { gitHubReactToIssueTool } from "./tools/react-to-issue.js";
import { gitHubCloneRepositoryTool } from "./tools/clone-repository.js";
import { gitHubCommentOnIssueTool } from "./tools/comment-on-issue.js";
import { gitHubCommentOnPullRequestTool } from "./tools/comment-on-pull-request.js";
import { gitHubIssueTool } from "./tools/create-issue.js";
import { gitHubGetDeploymentTool } from "./tools/get-deployment.js";
import { gitHubGetIssueTool } from "./tools/get-issue.js";
import { createGitHubPullRequestTool } from "./tools/create-pull-request.js";
import { createGitHubCreateRepositoryTool } from "./tools/create-repository.js";
import type { GitHubPullRequestSubscriptionConfig } from "./events/pull-request.js";
import { gitHubGetPullRequestTool } from "./tools/get-pull-request.js";
import { gitHubGetReleaseTool } from "./tools/get-release.js";
import { gitHubGetRepositoryTool } from "./tools/get-repository.js";
import { gitHubGetStatusTool } from "./tools/get-status.js";
import { gitHubUpdateIssueTool } from "./tools/update-issue.js";
import { createGitHubUpdateIssueCommentTool } from "./tools/update-issue-comment.js";
import { createGitHubUpdatePullRequestTool } from "./tools/update-pull-request.js";
import { createGitHubUpdatePullRequestFeedbackTool } from "./tools/update-pull-request-feedback.js";
import { createGitHubResolvePullRequestReviewThreadTool } from "./tools/resolve-pull-request-review-thread.js";
import { gitHubSubmitPullRequestReviewTool } from "./tools/submit-pull-request-review.js";
import { withGitHubText } from "./tool-support/github-text.js";

/** Opt-ins for GitHub plugin behavior that is still being tested. */
export interface GitHubPluginExperiments {
  /**
   * Check pull request descriptions with the decision model before a create
   * or update, and reject ones with check results, a work log, chat talk, or
   * no reason.
   */
  pullRequestDescriptionChecks?: boolean;
}

/** The GitHub plugin's tools for one deployment configuration. */
export function createGitHubTools(
  botEmail?: string,
  pullRequestSubscription?: GitHubPullRequestSubscriptionConfig,
  experimental: GitHubPluginExperiments = {},
): Record<string, PluginToolDefinition> {
  const descriptionChecks = experimental.pullRequestDescriptionChecks ?? false;
  return withGitHubText({
    reactToIssue: gitHubReactToIssueTool,
    cloneRepository: gitHubCloneRepositoryTool,
    commentOnIssue: gitHubCommentOnIssueTool,
    commentOnPullRequest: gitHubCommentOnPullRequestTool,
    createIssue: gitHubIssueTool,
    createPullRequest: createGitHubPullRequestTool(
      pullRequestSubscription,
      descriptionChecks,
    ),
    createRepository: createGitHubCreateRepositoryTool(ctx),
    getDeployment: gitHubGetDeploymentTool,
    getIssue: gitHubGetIssueTool,
    getPullRequest: gitHubGetPullRequestTool,
    getRelease: gitHubGetReleaseTool,
    getRepository: gitHubGetRepositoryTool,
    getStatus: gitHubGetStatusTool,
    resolvePullRequestReviewThread:
      createGitHubResolvePullRequestReviewThreadTool(botEmail),
    submitPullRequestReview: gitHubSubmitPullRequestReviewTool,
    updateIssue: gitHubUpdateIssueTool,
    updateIssueComment: createGitHubUpdateIssueCommentTool(botEmail),
    updatePullRequest: createGitHubUpdatePullRequestTool(descriptionChecks),
    updatePullRequestFeedback:
      createGitHubUpdatePullRequestFeedbackTool(botEmail),
  });
}
