import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { EventPerson } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { slackMention } from "@/chat/slack/mrkdwn";
import { juniorIdentities } from "@/db/schema";

const linkedSlackIdentity = alias(juniorIdentities, "event_people_slack");

function personKey(person: EventPerson): string | undefined {
  if ("email" in person) {
    const email = normalizeIdentityEmail(person.email);
    return email ? `email:${email}` : undefined;
  }
  const handle = person.handle.trim().toLowerCase();
  return handle ? `${person.provider}:${handle}` : undefined;
}

function personCondition(person: EventPerson): SQL | undefined {
  if ("email" in person) {
    const email = normalizeIdentityEmail(person.email);
    return email
      ? and(
          eq(juniorIdentities.emailVerified, true),
          eq(juniorIdentities.emailNormalized, email),
        )
      : undefined;
  }
  return and(
    eq(juniorIdentities.provider, person.provider),
    sql`lower(${juniorIdentities.handle}) = lower(${person.handle.trim()})`,
  );
}

/**
 * Resolve Event people to Slack mentions through linked user identities.
 *
 * A person resolves only when exactly one linked Slack user matches. Core
 * drops unlinked and ambiguous people, so a provider value never guesses a
 * mention. The result keeps input order and has no duplicates.
 */
export async function resolveEventPeopleMentions(
  people: readonly EventPerson[],
): Promise<string[]> {
  const conditions = people
    .map(personCondition)
    .filter((condition): condition is SQL => condition !== undefined);
  if (conditions.length === 0) return [];

  const rows = await getSqlExecutor()
    .db()
    .select({
      emailNormalized: juniorIdentities.emailNormalized,
      emailVerified: juniorIdentities.emailVerified,
      handle: juniorIdentities.handle,
      provider: juniorIdentities.provider,
      slackUserId: linkedSlackIdentity.providerSubjectId,
    })
    .from(juniorIdentities)
    .innerJoin(
      linkedSlackIdentity,
      and(
        eq(linkedSlackIdentity.userId, juniorIdentities.userId),
        eq(linkedSlackIdentity.kind, "user"),
        eq(linkedSlackIdentity.provider, "slack"),
      ),
    )
    .where(and(eq(juniorIdentities.kind, "user"), or(...conditions)))
    .limit(200);

  const slackUsersByKey = new Map<string, Set<string>>();
  const add = (key: string, slackUserId: string) => {
    const users = slackUsersByKey.get(key) ?? new Set<string>();
    users.add(slackUserId);
    slackUsersByKey.set(key, users);
  };
  for (const row of rows) {
    if (row.handle) {
      add(`${row.provider}:${row.handle.toLowerCase()}`, row.slackUserId);
    }
    if (row.emailVerified && row.emailNormalized) {
      add(`email:${row.emailNormalized}`, row.slackUserId);
    }
  }

  const mentions: string[] = [];
  for (const person of people) {
    const key = personKey(person);
    const users = key ? slackUsersByKey.get(key) : undefined;
    if (users?.size !== 1) continue;
    const mention = slackMention([...users][0]!);
    if (!mentions.includes(mention)) mentions.push(mention);
  }
  return mentions;
}
