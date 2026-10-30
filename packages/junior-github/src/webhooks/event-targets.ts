/**
 * Event data, event key, and target helpers shared by the GitHub webhook
 * normalizers.
 */
import type { EventInput } from "@sentry/junior-plugin-api";
import { gitHubRepositoryResource } from "../events/repository.js";

/**
 * Drop missing values from event data. A filter on a value that GitHub did not
 * send then does not match.
 */
export function definedValues(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

/** Build the event key for one event type from one webhook delivery. */
export function gitHubEventKey(deliveryId: string, eventType: string): string {
  return `github:${deliveryId}:${eventType}`;
}

/**
 * Address a pull request event through both the pull request and its
 * repository. Only the pull request copy keeps `terminal`, so a terminal
 * event never completes a repository Watch.
 */
export function pullRequestTargets(
  event: EventInput,
  repo: string,
): EventInput[] {
  const { terminal: _terminal, ...repositoryEvent } = event;
  return [
    event,
    {
      ...repositoryEvent,
      identifier: gitHubRepositoryResource({ repo }).identifier,
    },
  ];
}
