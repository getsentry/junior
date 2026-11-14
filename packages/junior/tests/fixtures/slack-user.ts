import type { User } from "@sentry/junior-plugin-api";
import { getDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
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

/**
 * Seed one Slack member, and optionally a provider account that the OAuth
 * account-linking flow linked to them, like a person who connected it.
 * Return the User id.
 */
export async function seedLinkedPerson(args: {
  email: string;
  linked?: { handle?: string; provider: string; subjectId: string };
  slackTeamId?: string;
  slackUserId: string;
}): Promise<string> {
  const slack = await upsertIdentity(getSqlExecutor(), {
    kind: "user",
    provider: "slack",
    providerTenantId: args.slackTeamId ?? "T123",
    providerSubjectId: args.slackUserId,
    email: args.email,
    emailVerified: true,
  });
  if (args.linked) {
    await upsertLinkedIdentity(getSqlExecutor(), slack.userId!, {
      kind: "user",
      provider: args.linked.provider,
      providerSubjectId: args.linked.subjectId,
      ...(args.linked.handle ? { handle: args.linked.handle } : undefined),
    });
  }
  return slack.userId!;
}
