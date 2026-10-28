import { and, eq, inArray } from "drizzle-orm";
import { lookupSlackUser } from "@/chat/slack/user";
import type { JuniorSqlDatabase } from "@/db/db";
import { juniorIdentities, juniorUsers } from "@/db/schema";
import type { ActorIdentity } from "./schema/conversation";

// Display text keeps Slack user mentions as `<@U123>` or `<@U123|label>`.
const SLACK_USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^<>]*)?>/g;

/**
 * Display text from one API object, such as one event or one Automation.
 * `tenantId` is the Slack workspace of the mentions. Without it, only known
 * Junior identities resolve.
 */
export type MentionSource = {
  tenantId?: string;
  texts: readonly (string | undefined)[];
};

function mentionedSlackUserIds(texts: MentionSource["texts"]): string[] {
  const ids = texts.flatMap((text) =>
    text ? [...text.matchAll(SLACK_USER_MENTION_RE)].map((m) => m[1]!) : [],
  );
  return [...new Set(ids)];
}

/**
 * Resolve the people that each source mentions, in source order. Every API
 * that returns display text uses this, so the dashboard can show the same
 * names and People links everywhere. It does one identity query per Slack
 * workspace.
 */
export async function resolveMentions(
  executor: JuniorSqlDatabase,
  sources: readonly MentionSource[],
): Promise<ActorIdentity[][]> {
  const idsBySource = sources.map((source) =>
    mentionedSlackUserIds(source.texts),
  );
  const idsByTenant = new Map<string | undefined, Set<string>>();
  sources.forEach((source, index) => {
    if (idsBySource[index]!.length === 0) return;
    const ids = idsByTenant.get(source.tenantId) ?? new Set<string>();
    for (const id of idsBySource[index]!) ids.add(id);
    idsByTenant.set(source.tenantId, ids);
  });
  const peopleByTenant = new Map(
    await Promise.all(
      [...idsByTenant].map(
        async ([tenantId, ids]) =>
          [
            tenantId,
            await readMentionedPeople(executor, tenantId, [...ids]),
          ] as const,
      ),
    ),
  );
  return sources.map((source, index) => {
    const people = peopleByTenant.get(source.tenantId);
    return idsBySource[index]!.flatMap((id) => {
      const person = people?.get(id);
      return person ? [person] : [];
    });
  });
}

/**
 * Read current names for mentioned Slack users. Known Junior identities come
 * first. The email is set only for a linked, verified Junior user, because
 * that email is the People profile route.
 */
async function readMentionedPeople(
  executor: JuniorSqlDatabase,
  tenantId: string | undefined,
  userIds: string[],
): Promise<Map<string, ActorIdentity>> {
  const rows = await executor
    .db()
    .select({
      displayName: juniorIdentities.displayName,
      emailVerified: juniorIdentities.emailVerified,
      handle: juniorIdentities.handle,
      providerSubjectId: juniorIdentities.providerSubjectId,
      userDisplayName: juniorUsers.displayName,
      userEmail: juniorUsers.primaryEmail,
    })
    .from(juniorIdentities)
    .leftJoin(juniorUsers, eq(juniorUsers.id, juniorIdentities.userId))
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        inArray(juniorIdentities.providerSubjectId, userIds),
        tenantId ? eq(juniorIdentities.providerTenantId, tenantId) : undefined,
      ),
    );

  const people = new Map<string, ActorIdentity>();
  for (const row of rows) {
    if (people.has(row.providerSubjectId)) continue;
    const fullName = row.userDisplayName?.trim() || row.displayName?.trim();
    const email = row.emailVerified ? row.userEmail?.trim() : undefined;
    people.set(row.providerSubjectId, {
      slackUserId: row.providerSubjectId,
      ...(fullName ? { fullName } : undefined),
      ...(row.handle ? { slackUserName: row.handle } : undefined),
      ...(email ? { email } : undefined),
    });
  }

  // Ask Slack for a name when Junior has none. Keep any known profile email.
  const unnamed = userIds.filter((id) => {
    const person = people.get(id);
    return !person?.fullName && !person?.slackUserName;
  });
  if (tenantId && unnamed.length > 0) {
    const profiles = await Promise.all(
      unnamed.map((id) => lookupSlackUser(tenantId, id)),
    );
    unnamed.forEach((id, index) => {
      const profile = profiles[index];
      if (!profile?.fullName && !profile?.userName) return;
      people.set(id, {
        ...people.get(id),
        slackUserId: id,
        ...(profile.fullName ? { fullName: profile.fullName } : undefined),
        ...(profile.userName ? { slackUserName: profile.userName } : undefined),
      });
    });
  }
  return people;
}
