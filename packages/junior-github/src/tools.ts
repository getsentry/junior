import {
  definePluginTool,
  type PluginToolDefinition,
  type ToolRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import {
  createGitHubReactToIssueTool,
  gitHubReactToIssueToolDefinition,
} from "./tools/react-to-issue.js";
import {
  createGitHubCloneRepositoryTool,
  gitHubCloneRepositoryToolDefinition,
} from "./tools/clone-repository.js";
import {
  createGitHubCommentOnIssueTool,
  gitHubCommentOnIssueToolDefinition,
} from "./tools/comment-on-issue.js";
import {
  createGitHubCommentOnPullRequestTool,
  gitHubCommentOnPullRequestToolDefinition,
} from "./tools/comment-on-pull-request.js";
import {
  createGitHubIssueTool,
  gitHubIssueToolDefinition,
} from "./tools/create-issue.js";
import {
  createGitHubGetDeploymentTool,
  gitHubGetDeploymentToolDefinition,
} from "./tools/get-deployment.js";
import {
  createGitHubGetIssueTool,
  gitHubGetIssueToolDefinition,
} from "./tools/get-issue.js";
import {
  createGitHubPullRequestTool,
  gitHubPullRequestToolDefinition,
} from "./tools/create-pull-request.js";
import type { GitHubPullRequestSubscriptionConfig } from "./events/pull-request.js";
import {
  createGitHubGetPullRequestTool,
  gitHubGetPullRequestToolDefinition,
} from "./tools/get-pull-request.js";
import {
  createGitHubGetReleaseTool,
  gitHubGetReleaseToolDefinition,
} from "./tools/get-release.js";
import {
  createGitHubGetRepositoryTool,
  gitHubGetRepositoryToolDefinition,
} from "./tools/get-repository.js";
import {
  createGitHubGetStatusTool,
  gitHubGetStatusToolDefinition,
} from "./tools/get-status.js";
import {
  createGitHubUpdateIssueTool,
  gitHubUpdateIssueToolDefinition,
} from "./tools/update-issue.js";
import {
  createGitHubUpdateIssueCommentTool,
  gitHubUpdateIssueCommentToolDefinition,
} from "./tools/update-issue-comment.js";
import {
  createGitHubUpdatePullRequestTool,
  gitHubUpdatePullRequestToolDefinition,
} from "./tools/update-pull-request.js";
import {
  createGitHubUpdatePullRequestFeedbackTool,
  gitHubUpdatePullRequestFeedbackToolDefinition,
} from "./tools/update-pull-request-feedback.js";
import {
  createGitHubResolvePullRequestReviewThreadTool,
  gitHubResolvePullRequestReviewThreadToolDefinition,
} from "./tools/resolve-pull-request-review-thread.js";
import {
  createGitHubSubmitPullRequestReviewTool,
  gitHubSubmitPullRequestReviewToolDefinition,
} from "./tools/submit-pull-request-review.js";

import { withGitHubText } from "./tool-support/github-text.js";

/** Model-facing definitions of the GitHub plugin's tools. */
export function gitHubToolDefinitions(): Record<string, PluginToolDefinition> {
  return {
    reactToIssue: definePluginTool(gitHubReactToIssueToolDefinition),
    cloneRepository: definePluginTool(gitHubCloneRepositoryToolDefinition),
    commentOnIssue: definePluginTool(gitHubCommentOnIssueToolDefinition),
    commentOnPullRequest: definePluginTool(
      gitHubCommentOnPullRequestToolDefinition,
    ),
    createIssue: definePluginTool(gitHubIssueToolDefinition),
    createPullRequest: definePluginTool(gitHubPullRequestToolDefinition),
    getDeployment: definePluginTool(gitHubGetDeploymentToolDefinition),
    getIssue: definePluginTool(gitHubGetIssueToolDefinition),
    getPullRequest: definePluginTool(gitHubGetPullRequestToolDefinition),
    getRelease: definePluginTool(gitHubGetReleaseToolDefinition),
    getRepository: definePluginTool(gitHubGetRepositoryToolDefinition),
    getStatus: definePluginTool(gitHubGetStatusToolDefinition),
    resolvePullRequestReviewThread: definePluginTool(
      gitHubResolvePullRequestReviewThreadToolDefinition,
    ),
    submitPullRequestReview: definePluginTool(
      gitHubSubmitPullRequestReviewToolDefinition,
    ),
    updateIssue: definePluginTool(gitHubUpdateIssueToolDefinition),
    updateIssueComment: definePluginTool(
      gitHubUpdateIssueCommentToolDefinition,
    ),
    updatePullRequest: definePluginTool(gitHubUpdatePullRequestToolDefinition),
    updatePullRequestFeedback: definePluginTool(
      gitHubUpdatePullRequestFeedbackToolDefinition,
    ),
  };
}

/** Opt-ins for GitHub plugin behavior that is still being tested. */
export interface GitHubPluginExperiments {
  /**
   * Check pull request descriptions with the decision model before a create
   * or update, and reject ones with check results, a work log, chat talk, or
   * no reason.
   */
  pullRequestDescriptionChecks?: boolean;
}

/** Bind the GitHub plugin's tools to one Turn. */
export function createGitHubTools(
  ctx: ToolRegistrationHookContext,
  botEmail?: string,
  pullRequestSubscription?: GitHubPullRequestSubscriptionConfig,
  experimental: GitHubPluginExperiments = {},
): Record<string, PluginToolDefinition> {
  const descriptionDecider = experimental.pullRequestDescriptionChecks
    ? ctx.decider
    : undefined;
  return withGitHubText(
    {
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
    },
    ctx.users,
  );
}
