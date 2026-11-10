import {
  and,
  eq,
  exists,
  gt,
  inArray,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { JuniorDatabase } from "@/db/db";
import { juniorConversationEvents, juniorConversations } from "@/db/schema";

/**
 * How long a person can finish an authorization. The MCP auth session and the
 * dashboard connect prompt expire after this time, so the parked Turn cannot
 * resume after it.
 */
const AUTHORIZATION_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * Events that end an authorization wait: the person connected, or a Turn
 * started or ended after the request. A stop or new input ends the parked
 * Turn with `turn_completed`.
 */
const AUTHORIZATION_WAIT_END_TYPES = [
  "authorization_completed",
  "turn_started",
  "turn_completed",
  "turn_failed",
];

/**
 * SQL: the Conversation waits on a person to finish an authorization. A Turn
 * that needs a connection parks with execution `idle`, so only the durable
 * `authorization_requested` event shows the wait. Each lookup reads
 * `junior_conversation_events_type_idx`.
 */
function awaitsAuthorization(
  db: JuniorDatabase,
  conversationId: AnyPgColumn,
  now: Date,
): SQL {
  const requested = alias(juniorConversationEvents, "authorization_request");
  const ended = alias(juniorConversationEvents, "authorization_wait_end");
  return exists(
    db
      .select({ seq: requested.seq })
      .from(requested)
      .where(
        and(
          eq(requested.conversationId, conversationId),
          eq(requested.type, "authorization_requested"),
          gt(
            requested.createdAt,
            new Date(now.getTime() - AUTHORIZATION_WAIT_MS),
          ),
          notExists(
            db
              .select({ seq: ended.seq })
              .from(ended)
              .where(
                and(
                  eq(ended.conversationId, requested.conversationId),
                  inArray(ended.type, AUTHORIZATION_WAIT_END_TYPES),
                  gt(ended.seq, requested.seq),
                ),
              ),
          ),
        ),
      ),
  );
}

/**
 * SQL: the root or a child Conversation of `rootConversationId` waits on a
 * person to finish an authorization.
 */
export function treeAwaitsAuthorization(
  db: JuniorDatabase,
  rootConversationId: AnyPgColumn,
  now: Date,
): SQL {
  const tree = alias(juniorConversations, "authorization_tree");
  return exists(
    db
      .select({ conversationId: tree.conversationId })
      .from(tree)
      .where(
        and(
          or(
            eq(tree.conversationId, rootConversationId),
            eq(tree.rootConversationId, rootConversationId),
          ),
          awaitsAuthorization(db, tree.conversationId, now),
        ),
      ),
  );
}

/**
 * Return the roots, of the given root ids, where the root or a child
 * Conversation waits on a person to finish an authorization.
 */
export async function readAwaitingAuthorizationRootIds(
  db: JuniorDatabase,
  rootConversationIds: string[],
  now: Date,
): Promise<Set<string>> {
  if (rootConversationIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({
      rootConversationId: sql<string>`coalesce(${juniorConversations.rootConversationId}, ${juniorConversations.conversationId})`,
    })
    .from(juniorConversations)
    .where(
      and(
        or(
          inArray(juniorConversations.conversationId, rootConversationIds),
          inArray(juniorConversations.rootConversationId, rootConversationIds),
        ),
        awaitsAuthorization(db, juniorConversations.conversationId, now),
      ),
    );
  return new Set(rows.map((row) => row.rootConversationId));
}
