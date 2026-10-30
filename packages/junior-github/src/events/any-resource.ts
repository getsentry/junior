import type { PluginEvents } from "@sentry/junior-plugin-api";
import { GITHUB_DEPLOYMENT_EVENTS } from "./deployment.js";
import { GITHUB_ISSUE_EVENTS } from "./issue.js";
import { GITHUB_PULL_REQUEST_EVENTS } from "./pull-request.js";
import { GITHUB_RELEASE_EVENTS } from "./release.js";

const NEEDS_REPO = { requiredFilter: "repo" } as const;

/**
 * GitHub events that an event automation can select with no identifier.
 *
 * - Deployment events can run for every repository. They carry status facts,
 *   Junior adds no reaction, and they load nothing from GitHub.
 * - Release, issue, and pull request events need a `repo` filter. They carry
 *   release notes, titles, bodies, comments, or reviews from repositories
 *   that can be private. Comments and reviews also make Junior add a
 *   reaction, and pull request events can load authors and roles from
 *   GitHub for each match.
 */
export const GITHUB_ANY_RESOURCE_EVENTS: NonNullable<
  PluginEvents["anyResourceEvents"]
> = Object.fromEntries([
  ...GITHUB_DEPLOYMENT_EVENTS.map((eventType) => [eventType, {}]),
  ...[
    ...GITHUB_RELEASE_EVENTS,
    ...GITHUB_ISSUE_EVENTS,
    ...GITHUB_PULL_REQUEST_EVENTS,
  ].map((eventType) => [eventType, NEEDS_REPO]),
]);
