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
  for (const eventType of [...GITHUB_RELEASE_EVENTS, ...GITHUB_ISSUE_EVENTS]) {
    declarations[eventType] = { reach: NEEDS_REPO };
  }
  for (const eventType of GITHUB_PULL_REQUEST_EVENTS) {
    const declaration: PluginEventDeclaration = { reach: NEEDS_REPO };
    const guidance = pullRequestGuidance[eventType];
    if (guidance) declaration.guidance = guidance;
    declarations[eventType] = declaration;
  }
  return declarations;
}
