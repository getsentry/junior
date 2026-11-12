import type { User } from "@sentry/junior-plugin-api";
import { getDb } from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { juniorIdentities } from "@/db/schema";

/** A Junior User with a linked Slack identity, like a person who signed in. */
export async function linkSlackUser(
  email: string,
  slackUserId: string,
): Promise<User> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  const now = new Date(1);
  await getDb()
    .insert(juniorIdentities)
    .values({
      createdAt: now,
      displayName: email.split("@")[0]!,
      email,
      emailNormalized: email,
      emailVerified: true,
      id: `identity:${slackUserId}`,
      kind: "user",
      provider: "slack",
      providerSubjectId: slackUserId,
      providerTenantId: "T123",
      updatedAt: now,
      userId: user.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorIdentities.provider,
        juniorIdentities.providerTenantId,
        juniorIdentities.providerSubjectId,
      ],
      set: { userId: user.id },
    });
  return user;
}
