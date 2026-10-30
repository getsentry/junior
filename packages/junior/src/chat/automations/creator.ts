import type { User } from "@sentry/junior-plugin-api";

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
