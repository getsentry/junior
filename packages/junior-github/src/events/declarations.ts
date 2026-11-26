import type {
  EventReach,
  PluginEventDeclaration,
} from "@sentry/junior-plugin-api";
import { GITHUB_DEPLOYMENT_EVENTS } from "./deployment.js";
import { GITHUB_ISSUE_EVENTS } from "./issue.js";
import {
  GITHUB_PULL_REQUEST_EVENTS,
  type GitHubPullRequestEvent,
} from "./pull-request.js";
import { GITHUB_RELEASE_EVENTS } from "./release.js";

const NEEDS_REPO: EventReach = { anyOf: ["repo"] };

/** How each Event reads after the name of its pull request or issue. */
const GITHUB_EVENT_PHRASES: Record<string, string> = {
  "issue.closed": "is closed",
  "issue.comment.created": "gets a new comment",
  "issue.opened": "is opened",
  "issue.reopened": "is reopened",
  "issue.updated": "is edited",
  "pull_request.checks.failed": "fails its checks",
  "pull_request.checks.passed": "passes its checks",
  "pull_request.checks.recovered": "passes its checks again",
  "pull_request.closed_unmerged": "is closed without merging",
  "pull_request.comment.created": "gets a new comment",
  "pull_request.converted_to_draft": "is converted to a draft",
  "pull_request.merge_conflict": "gets a merge conflict",
  "pull_request.merge_conflict.resolved": "no longer has a merge conflict",
  "pull_request.merged": "is merged",
  "pull_request.opened": "is opened",
  "pull_request.ready_for_review": "is ready for review",
  "pull_request.reopened": "is reopened",
  "pull_request.review.approved": "is approved",
  "pull_request.review.changes_requested": "gets changes requested",
  "pull_request.review.commented": "gets a review comment",
  "pull_request.review_comment.created": "gets an inline review comment",
  "pull_request.review_requested": "gets a review request",
  "pull_request.synchronized": "gets new commits",
};

/**
 * Declare the reach and guidance of every GitHub event.
 *
 * - Deployment events reach every repository. They carry status facts,
 *   Junior adds no reaction, and they load nothing from GitHub.
 * - Release, issue, and pull request events need a `repo` filter. They carry
 *   release notes, titles, bodies, comments, or reviews from repositories
 *   that can be private, and comments and reviews make Junior add a
 *   reaction. The filter limits how many repositories a trigger covers. It
 *   does not check that the person can see the repository.
 *
 * Pull request filters such as `authors` and `openerRole` load data from
 * GitHub. Core skips a trigger with no identifier when its `repo` filter does
 * not match the event, so it loads nothing for other repositories.
 */
export function gitHubEventDeclarations(
  pullRequestGuidance: Partial<Record<GitHubPullRequestEvent, string>>,
): Record<string, PluginEventDeclaration> {
  const declarations: Record<string, PluginEventDeclaration> = {};
  for (const eventType of GITHUB_DEPLOYMENT_EVENTS) {
    declarations[eventType] = { reach: "all" };
  }
  for (const eventType of GITHUB_RELEASE_EVENTS) {
    declarations[eventType] = { reach: NEEDS_REPO };
  }
  for (const eventType of GITHUB_ISSUE_EVENTS) {
    declarations[eventType] = {
      phrase: GITHUB_EVENT_PHRASES[eventType],
      reach: NEEDS_REPO,
    };
  }
  for (const eventType of GITHUB_PULL_REQUEST_EVENTS) {
    const declaration: PluginEventDeclaration = {
      phrase: GITHUB_EVENT_PHRASES[eventType],
      reach: NEEDS_REPO,
    };
    const guidance = pullRequestGuidance[eventType];
    if (guidance) declaration.guidance = guidance;
    declarations[eventType] = declaration;
  }
  return declarations;
}
