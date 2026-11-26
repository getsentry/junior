import { and, eq, like, notLike, sql } from "drizzle-orm";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorInboxItemConversations,
  juniorInboxItems,
} from "@/db/schema";
import {
  PLUGIN_INBOX_ITEM_KEY_PREFIX,
  TODO_INBOX_ITEM_KEY_PREFIX,
  inboxItemOwnedByConversation,
  inboxItemPlugin,
} from "./access";
import { inboxItemNeedsUserNow } from "./store";

/** One open Inbox item that a Conversation waits on a User for. */
type WaitingItem = {
  /** The plugin that added the item, such as `github`. Unset for an agent. */
  plugin?: string;
  title: string;
};

/** One Conversation that waits on a User, with its open Inbox items. */
export type WaitingConversation = {
  conversationId: string;
  /** Open Inbox items on this Conversation that need the User, newest first. */
  items: WaitingItem[];
  /** When the oldest of those items was added: when the wait began. */
  waitingSince: string;
};

// The root of a linked Conversation. An item that a child agent adds links
// the child, and the feed lists only roots.
const waitingRootId =
  sql<string>`coalesce(${juniorConversations.rootConversationId}, ${juniorInboxItemConversations.conversationId})`.as(
    "waiting_root_id",
  );

// The root of the Conversation that owns a To-do's item. The item links no
// Conversation, so it waits on the person in its owner's tree.
const waitingTodoRootId =
  sql<string>`coalesce(${juniorConversations.rootConversationId}, ${juniorInboxItems.ownerId})`.as(
    "waiting_root_id",
  );

/** Open items that need the User now, with the root where each one waits. */
function waitingItemsQuery(db: JuniorDatabase, userId: string) {
  const columns = {
    createdAt: juniorInboxItems.createdAt,
    dedupeKey: juniorInboxItems.dedupeKey,
    itemId: juniorInboxItems.id,
    title: juniorInboxItems.title,
  };
  return db
    .select({ conversationId: waitingRootId, ...columns })
    .from(juniorInboxItemConversations)
    .innerJoin(
      juniorInboxItems,
      eq(juniorInboxItems.id, juniorInboxItemConversations.itemId),
    )
    .leftJoin(
      juniorConversations,
      eq(
        juniorConversations.conversationId,
        juniorInboxItemConversations.conversationId,
      ),
    )
    .where(inboxItemNeedsUserNow(userId))
    .union(
      db
        .select({ conversationId: waitingTodoRootId, ...columns })
        .from(juniorInboxItems)
        .leftJoin(
          juniorConversations,
          eq(juniorConversations.conversationId, juniorInboxItems.ownerId),
        )
        .where(
          and(
            inboxItemNeedsUserNow(userId),
            eq(juniorInboxItems.ownerKind, "conversation"),
            like(juniorInboxItems.dedupeKey, `${TODO_INBOX_ITEM_KEY_PREFIX}%`),
          ),
        ),
    );
}

/**
 * Return a query for the ids of the root Conversations that wait on a User,
 * as `listWaitingConversations` lists them, to filter another query by.
 */
export function waitingConversationIdsQuery(
  db: JuniorDatabase,
  userId: string,
) {
  const items = waitingItemsQuery(db, userId).as("waiting_items");
  return db.select({ conversationId: items.conversationId }).from(items);
}

/**
 * Return whether a root Conversation waits on a User, as
 * `listWaitingConversations` decides it.
 */
export async function isConversationWaitingOnUser(
  db: JuniorDatabase,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const items = waitingItemsQuery(db, userId).as("waiting_items");
  const rows = await db
    .select({ conversationId: items.conversationId })
    .from(items)
    .where(eq(items.conversationId, conversationId))
    .limit(1);
  return rows.length > 0;
}

/**
 * List the root Conversations that wait on a User: each root or one of its
 * child conversations is linked to, or owns a To-do's, open item that needs
 * the User now (`inboxItemNeedsUserNow`), so a snoozed item leaves it out.
 */
export async function listWaitingConversations(
  db: JuniorDatabase,
  userId: string,
): Promise<WaitingConversation[]> {
  const rows = (await waitingItemsQuery(db, userId)).sort(
    (left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.itemId.localeCompare(left.itemId),
  );
  const waiting = new Map<string, WaitingConversation>();
  for (const row of rows) {
    const plugin = inboxItemPlugin(row.dedupeKey);
    const item = { title: row.title, ...(plugin ? { plugin } : undefined) };
    const current = waiting.get(row.conversationId);
    // Rows come newest first, so each later row is older.
    if (current) {
      current.items.push(item);
      current.waitingSince = row.createdAt.toISOString();
    } else
      waiting.set(row.conversationId, {
        conversationId: row.conversationId,
        items: [item],
        waitingSince: row.createdAt.toISOString(),
      });
  }
  return [...waiting.values()].sort((left, right) =>
    left.conversationId.localeCompare(right.conversationId),
  );
}

/**
 * Return whether a Conversation waits on a person's answer to an open
 * question that its agent asked. The answer starts its next Turn. A plugin
 * item or a To-do starts no Turn, so neither counts.
 */
export async function waitsOnInboxAnswer(
  db: JuniorDatabase,
  conversationId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: juniorInboxItems.id })
    .from(juniorInboxItems)
    .where(
      and(
        inboxItemOwnedByConversation(conversationId),
        eq(juniorInboxItems.kind, "action"),
        eq(juniorInboxItems.status, "open"),
        notLike(juniorInboxItems.dedupeKey, `${PLUGIN_INBOX_ITEM_KEY_PREFIX}%`),
        notLike(juniorInboxItems.dedupeKey, `${TODO_INBOX_ITEM_KEY_PREFIX}%`),
      ),
    )
    .limit(1);
  return row !== undefined;
}
