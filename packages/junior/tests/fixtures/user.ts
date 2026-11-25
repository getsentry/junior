import type { User } from "@sentry/junior-plugin-api";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { getSqlExecutor } from "@/chat/db";
import { addSlackChannelMember } from "../msw/handlers/slack-api";

/** Build a canonical viewer for reporting tests that do not need persisted identities. */
export function testViewer(email: string): User {
  return { email, id: `test:${email.trim().toLowerCase()}`, identities: [] };
}

/**
 * Sign in like the dashboard: resolve or create the persisted User. Access
 * reads Participant rows by User id, so a viewer that must match a
 * Participant needs this, not `testViewer`.
 */
export async function signedInViewer(email: string): Promise<User> {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`Expected a viewer for ${email}`);
  return viewer;
}

/**
 * Sign in a person whose linked Slack user is in a Slack channel now. A
 * Slack-backed private Conversation follows its channel, so a viewer of one
 * needs this.
 */
export async function signedInChannelMember(
  email: string,
  slack: { channelId: string; teamId: string; userId: string },
): Promise<User> {
  const user = await signedInViewer(email);
  await upsertLinkedIdentity(getSqlExecutor(), user.id, {
    kind: "user",
    provider: "slack",
    providerSubjectId: slack.userId,
    providerTenantId: slack.teamId,
  });
  addSlackChannelMember(slack.channelId, slack.userId);
  return await signedInViewer(email);
}
