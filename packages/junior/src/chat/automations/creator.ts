import type { SlackDestination, User } from "@sentry/junior-plugin-api";

/**
 * The person who reads or manages Automations. A Slack tool call also names
 * the active Slack channel and the Slack user who asks. People in the channel
 * can manage the Automations that deliver to it, also in private channels and
 * DMs.
 */
export type AutomationViewer = Pick<User, "identities"> & {
  channel?: SlackDestination;
  slackUserId?: string;
};

/**
 * Return whether the viewer created the Automation. Both kinds store the
 * creating Junior identity. A Slack tool call also owns the Automations that
 * its Slack user created in the same workspace, so a missing identity lookup
 * does not make the creator a non-creator.
 */
export function isAutomationCreator(
  viewer: AutomationViewer,
  automation: {
    creatorIdentityId: string;
    createdBy: { slackUserId: string };
    destination: { teamId: string };
  },
): boolean {
  if (
    viewer.identities.some(
      (identity) => identity.id === automation.creatorIdentityId,
    )
  )
    return true;
  return (
    viewer.slackUserId !== undefined &&
    viewer.channel?.teamId === automation.destination.teamId &&
    viewer.slackUserId === automation.createdBy.slackUserId
  );
}
