import { sql, type SQL } from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";

/**
 * How long a person can finish an authorization. The MCP auth session and the
 * dashboard connect prompt expire after this time, so the parked Turn cannot
 * resume after it.
 */
const AUTHORIZATION_WAIT = sql.raw(`interval '24 hours'`);

/**
 * The request and the events that end its wait: the person connected, or a
 * Turn started or ended after the request. A stop or new input ends the
 * parked Turn with `turn_completed`. A child agent invocation that needs a
 * connection abandons its Turn and ends it as `blocked`, so nothing resumes
 * it and its parent gets the result instead.
 */
const AUTHORIZATION_WAIT_EVENT_TYPES = [
  "authorization_requested",
  "authorization_completed",
  "turn_started",
  "turn_completed",
  "turn_failed",
];

/**
 * SQL: the Conversation waits on a person to finish an authorization. A Turn
 * that needs a connection parks with execution `idle`, so only the durable
 * `authorization_requested` event shows the wait: it is the newest of these
 * events and has not expired.
 */
export function awaitsAuthorization(conversationId: AnyPgColumn): SQL<boolean> {
  const events = juniorConversationEvents;
  return sql<boolean>`coalesce((
    select ${events.type} = 'authorization_requested'
      and ${events.createdAt} > now() - ${AUTHORIZATION_WAIT}
    from ${events}
    where ${events.conversationId} = ${conversationId}
      and ${events.type} in (${sql.join(
        AUTHORIZATION_WAIT_EVENT_TYPES.map((type) => sql`${type}`),
        sql`, `,
      )})
    order by ${events.seq} desc
    limit 1
  ), false)`;
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
        or ${tree.rootConversationId} = ${rootConversationId})
      and ${awaitsAuthorization(tree.conversationId)}
  )`;
}
