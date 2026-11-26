import { and, eq, sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";

/**
 * How long a person can finish an authorization. The MCP auth session and the
 * dashboard connect prompt expire after this time, so the parked Turn cannot
 * resume after it.
 */
const AUTHORIZATION_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * The events that end a request's wait: the person connected, or a
 * Turn started or ended after the request. A stop or new input ends the
 * parked Turn with `turn_completed`. A child agent's Turn on a parent message
 * that needs a connection abandons its Turn and ends it as `blocked`, so nothing resumes
 * it and its parent gets the result instead.
 */
const AUTHORIZATION_WAIT_END_TYPES = [
  "authorization_completed",
  "turn_started",
  "turn_completed",
  "turn_failed",
];

const waitEnd = alias(juniorConversationEvents, "authorization_wait_end");

/** The oldest request that still waits, on the app clock. */
function authorizationWaitStart(): string {
  return new Date(Date.now() - AUTHORIZATION_WAIT_MS).toISOString();
}

/**
 * SQL: the Conversation waits on a person to finish an authorization. A Turn
 * that needs a connection parks with execution `idle`, so only the durable
 * `authorization_requested` event shows the wait: it is the newest of these
 * events and has not expired. Build it for each query: it binds the app
 * clock, which also dated the request.
 */
export function awaitsAuthorization(conversationId: AnyPgColumn): SQL<boolean> {
  return authorizationWait(conversationId, sql`true`);
}

/**
 * SQL: the Conversation waits on this User to finish an authorization. The
 * request names the person by their User id, or by the Slack user id of
 * one of their Identities. Build it for each query, as `awaitsAuthorization`.
 */
export function awaitsAuthorizationFrom(
  conversationId: AnyPgColumn,
  userId: string,
): SQL<boolean> {
  const actorId = sql`${juniorConversationEvents.payload}->>'actorId'`;
  return authorizationWait(
    conversationId,
    sql`(${actorId} = ${userId} or ${actorId} in (select ${juniorIdentities.providerSubjectId} from ${juniorIdentities} where ${and(
      eq(juniorIdentities.userId, userId),
      eq(juniorIdentities.provider, "slack"),
    )}))`,
  );
}

/**
 * SQL: the Conversation has an authorization request that has not expired.
 * A request stops its wait at a fixed time, with no write, so a token that
 * must move then reads this. Build it for each query: it binds the app clock.
 */
export function hasUnexpiredAuthorizationRequest(
  conversationId: AnyPgColumn,
): SQL<boolean> {
  const events = juniorConversationEvents;
  // Postgres reads the Conversation's requests from
  // `junior_conversation_events_type_idx (conversation_id, type, seq)`. It is
  // a scalar subquery, not `exists`, so Postgres looks up each Conversation
  // and does not hash every recent request for each Conversation it checks.
  return sql<boolean>`coalesce((select true from ${events} where ${events.conversationId} = ${conversationId} and ${events.type} = 'authorization_requested' and ${events.createdAt} > ${authorizationWaitStart()}::timestamptz limit 1), false)`;
}

/**
 * SQL: the newest request is live, `requester` matches it, and no event
 * that ends a wait follows it.
 */
function authorizationWait(
  conversationId: AnyPgColumn,
  requester: SQL,
): SQL<boolean> {
  const events = juniorConversationEvents;
  const start = authorizationWaitStart();
  // Most Conversations have no request that can still wait. The first
  // check finds that without a read of the Conversation's newest events.
  // Only then does the newest request check each end type, from one end of
  // `junior_conversation_events_type_idx (conversation_id, type, seq)`.
  return sql<boolean>`(${hasUnexpiredAuthorizationRequest(conversationId)} and coalesce((
    select ${events.createdAt} > ${start}::timestamptz
      and ${requester}
      and not exists (
        select 1 from ${juniorConversationEvents} as ${waitEnd}
        where ${waitEnd.conversationId} = ${events.conversationId}
          and ${waitEnd.type} in (${sql.join(
            AUTHORIZATION_WAIT_END_TYPES.map((type) => sql`${type}`),
            sql`, `,
          )})
          and ${waitEnd.seq} > ${events.seq}
      )
    from ${events}
    where ${events.conversationId} = ${conversationId}
      and ${events.type} = 'authorization_requested'
    order by ${events.seq} desc
    limit 1
  ), false))`;
}

/**
 * SQL: the root or a child Conversation of `rootConversationId` waits on a
 * person to finish an authorization.
 */
export function treeAwaitsAuthorization(
  rootConversationId: AnyPgColumn,
): SQL<boolean> {
  const tree = alias(juniorConversations, "authorization_tree");
  return sql<boolean>`exists (
    select 1 from ${juniorConversations} as ${tree}
    where (${tree.conversationId} = ${rootConversationId}
        or ${tree.topLevelConversationId} = ${rootConversationId})
      and ${awaitsAuthorization(tree.conversationId)}
  )`;
}
