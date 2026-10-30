import type { User } from "@sentry/junior-plugin-api";
import { readIdentityByIdFromSql } from "@/chat/plugins/viewer";
import { slackMention } from "@/chat/slack/mrkdwn";
import type { JuniorDatabase } from "@/db/db";

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
 * Render the Automation creator for a run in its Destination.
 *
 * The creator identity is the source of truth, not the `createdBy` copy. The
 * create tools store the creator's Slack identity in the Destination
 * workspace, and the row cannot be deleted while the Automation exists. A
 * creator that does not resolve there is a broken invariant, so the run fails
 * instead of binding "me" to nobody or to the wrong person.
 */
export async function automationCreatorMention(
  db: JuniorDatabase,
  automation: {
    id: string;
    creatorIdentityId: string;
    destination: { teamId: string };
  },
): Promise<string> {
  const identity = (
    await readIdentityByIdFromSql(db, automation.creatorIdentityId)
  )?.identity;
  if (
    identity?.provider !== "slack" ||
    identity.providerTenantId !== automation.destination.teamId
  ) {
    throw new Error(
      `Automation ${automation.id} creator identity does not resolve in its Destination workspace.`,
    );
  }
  return slackMention(identity.providerSubjectId);
}
