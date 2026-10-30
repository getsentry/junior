import type { EventMatch } from "@sentry/junior-plugin-api";
import {
  LINEAR_ISSUE_EVENTS,
  linearIssueResource,
  linearTeamResource,
} from "./issue.js";

/**
 * Turn a saved Linear identifier into the filters that select the same issue
 * events. Issue and team identifiers share one form, so the shape decides:
 * an issue identifier is `TEAM-123`, and a team key has no `-`.
 */
export function linearIdentifierMatch(input: {
  identifier: string;
  eventType: string;
}): EventMatch | undefined {
  if (!(LINEAR_ISSUE_EVENTS as readonly string[]).includes(input.eventType))
    return undefined;
  const { identifier } = input;
  // Saved identifiers went through the plugin's `normalizeIdentifier`.
  if (/^[^\s-]+-\d+$/.test(identifier)) {
    return linearIssueResource({ identifier }).identifier === identifier
      ? { issueIdentifier: identifier }
      : undefined;
  }
  if (/^[^\s-]+$/.test(identifier)) {
    return linearTeamResource({ teamKey: identifier }).identifier === identifier
      ? { teamKey: identifier }
      : undefined;
  }
  return undefined;
}
