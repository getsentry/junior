import type { SlackDestination, User } from "@sentry/junior-plugin-api";

/**
 * The person who reads or manages Automations. A Slack tool call also names
 * the active Slack channel. People there can manage the Automations that
 * deliver to it, also in private channels and DMs.
 */
export type AutomationViewer = Pick<User, "identities"> & {
  channel?: SlackDestination;
};

/**
 * Return whether the viewer created the Automation. Both kinds store the
 * creating Junior identity, so one rule decides ownership.
 */
export function isAutomationCreator(
  viewer: AutomationViewer,
  automation: { creatorIdentityId: string },
): boolean {
  return viewer.identities.some(
    (identity) => identity.id === automation.creatorIdentityId,
  );
}
