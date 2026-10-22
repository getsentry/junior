import type { Identity, User } from "@sentry/junior-plugin-api";

/**
 * Return whether the user created the Automation. Both kinds store the
 * creating Junior identity, so one rule decides ownership.
 */
export function isAutomationCreator(
  user: User,
  automation: { creatorIdentityId: string },
): boolean {
  return user.identities.some(
    (identity) => identity.id === automation.creatorIdentityId,
  );
}

/**
 * Return whether a tool requester created the Automation. The requester may
 * have no linked user, so their own identity also counts.
 */
export function isRequesterAutomationCreator(
  requester: { identity: Identity; user?: User } | undefined,
  automation: { creatorIdentityId: string },
): boolean {
  if (!requester) return false;
  return (
    requester.identity.id === automation.creatorIdentityId ||
    (requester.user !== undefined &&
      isAutomationCreator(requester.user, automation))
  );
}
