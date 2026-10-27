import { and, eq, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { EventPerson } from "@sentry/junior-plugin-api";
import { getSqlExecutor } from "@/chat/db";
import { normalizeIdentityEmail } from "@/chat/identities/identity";
import { slackMention } from "@/chat/slack/mrkdwn";
import type { EventDoneBy } from "@/chat/task-input";
import { juniorIdentities } from "@/db/schema";

const linkedSlackIdentity = alias(juniorIdentities, "event_people_slack");

function personKey(person: EventPerson): string {
  return "email" in person
    ? `email:${normalizeIdentityEmail(person.email)}`
    : `${person.provider}:${person.handle.toLowerCase()}`;
}

function personCondition(person: EventPerson) {
  if ("email" in person) {
    return and(
      eq(juniorIdentities.emailVerified, true),
      eq(
        juniorIdentities.emailNormalized,
        normalizeIdentityEmail(person.email)!,
      ),
    );
  }
  return and(
    eq(juniorIdentities.provider, person.provider),
    sql`lower(${juniorIdentities.handle}) = lower(${person.handle})`,
  );
}

/** Slack mentions resolved from an Event. */
export interface EventMentions {
  /** Mentions of the Event people, in input order, with no duplicates. */
  people: string[];
  /** The person who did what the Event describes, when they resolve. */
  doneBy?: EventDoneBy;
}

/**
 * Resolve the Event people and the Event doer to Slack mentions through
 * linked user identities in one Slack workspace, with one query.
 *
 * A person resolves only when exactly one linked Slack user in that workspace
 * matches. Core drops unlinked and ambiguous people, so a provider value never
 * guesses a mention.
 */
export async function resolveEventMentions(
  event: { doneBy?: EventPerson; people?: readonly EventPerson[] },
  slackTeamId: string,
): Promise<EventMentions> {
  const people = event.people ?? [];
  const lookup = event.doneBy ? [...people, event.doneBy] : people;
  if (lookup.length === 0) return { people: [] };

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
        eq(linkedSlackIdentity.providerTenantId, slackTeamId),
      ),
    )
    .where(
      and(
        eq(juniorIdentities.kind, "user"),
        or(...lookup.map(personCondition)),
      ),
    );

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
  const mentionOf = (person: EventPerson): string | undefined => {
    const users = slackUsersByKey.get(personKey(person));
    return users?.size === 1 ? slackMention([...users][0]!) : undefined;
  };

  const mentions: string[] = [];
  for (const person of people) {
    const mention = mentionOf(person);
    if (mention && !mentions.includes(mention)) mentions.push(mention);
  }
  const doneByMention = event.doneBy ? mentionOf(event.doneBy) : undefined;
  if (!doneByMention || !event.doneBy) return { people: mentions };
  return {
    people: mentions,
    doneBy: {
      mention: doneByMention,
      ...("handle" in event.doneBy
        ? { handle: event.doneBy.handle }
        : undefined),
    },
  };
}
