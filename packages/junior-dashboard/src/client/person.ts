import type { ActorIdentity } from "@sentry/junior/api/schema";

/**
 * What a reference to one person needs: the name, the photo, and the email
 * that names their People page. The person card does not show the email.
 */
export type Person = {
  avatarUrl?: string | undefined;
  email?: string | undefined;
  name: string;
};

/** Return the person of an Actor, or nothing when it has no name to show. */
export function personFromActor(
  actor: ActorIdentity | undefined,
): Person | undefined {
  const name =
    actor?.fullName?.trim() ||
    actor?.slackUserName?.trim() ||
    actor?.email?.trim();
  if (!actor || !name) return undefined;
  return { avatarUrl: actor.avatarUrl, email: actor.email, name };
}

/** Return the person of a User record, such as an Inbox item assignee. */
export function personFromUser(user: {
  avatarUrl?: string | undefined;
  displayName?: string | undefined;
  email: string;
}): Person {
  return {
    avatarUrl: user.avatarUrl,
    email: user.email,
    name: user.displayName?.trim() || user.email,
  };
}

/** Return the creator of an Automation. */
export function automationCreator(automation: {
  createdBy: string;
  createdByAvatarUrl?: string | undefined;
  createdByEmail?: string | undefined;
}): Person {
  return {
    avatarUrl: automation.createdByAvatarUrl,
    email: automation.createdByEmail,
    name: automation.createdBy,
  };
}
