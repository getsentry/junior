import type { Identity } from "@sentry/junior-plugin-api";

/**
 * One provider account of the viewer. A stored Identity has an `id`. A tool
 * call also adds the account of its Actor, which can have no stored Identity.
 */
export type AutomationViewerIdentity = Pick<
  Identity,
  | "displayName"
  | "handle"
  | "provider"
  | "providerSubjectId"
  | "providerTenantId"
> & { id?: string };

/** Destination of an Automation: a channel or DM, never a thread. */
export type AutomationDestination = {
  platform: "slack";
  teamId: string;
  channelId: string;
};

/** Return the Destination filter value of the dashboard Automations search. */
export function destinationFilterValue(
  destination: AutomationDestination,
): string {
  return `${destination.teamId}:${destination.channelId}`;
}

/**
 * The person who reads or manages Automations. A tool call also names the
 * Destination of its Conversation Location. People in that Conversation can
 * manage the Automations that deliver to it, also in private channels and
 * DMs.
 */
export type AutomationViewer = {
  identities: readonly AutomationViewerIdentity[];
  location?: AutomationDestination;
};

/**
 * Return whether the account is the stored creator account of the
 * Automation. Automations store their creator as an account of the provider
 * that they deliver to.
 */
function isCreatorAccount(
  identity: AutomationViewerIdentity,
  automation: {
    createdBy: { slackUserId: string };
    destination: AutomationDestination;
  },
): boolean {
  return (
    identity.provider === automation.destination.platform &&
    identity.providerTenantId === automation.destination.teamId &&
    identity.providerSubjectId === automation.createdBy.slackUserId
  );
}

/**
 * Return whether the viewer created the Automation. Both kinds store the
 * creating Junior identity and the creator account. The account check keeps
 * the creator a creator when the identity lookup of a tool call returns
 * nothing.
 */
export function isAutomationCreator(
  viewer: AutomationViewer,
  automation: {
    creatorIdentityId: string;
    createdBy: { slackUserId: string };
    destination: AutomationDestination;
  },
): boolean {
  return viewer.identities.some(
    (identity) =>
      identity.id === automation.creatorIdentityId ||
      isCreatorAccount(identity, automation),
  );
}
