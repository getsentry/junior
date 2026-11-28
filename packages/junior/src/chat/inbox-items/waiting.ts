import { and, count, eq, not, sql, type SQL } from "drizzle-orm";
import { inboxItemOwnerConversationId } from "@/chat/inbox-items/owner";
import {
  inboxItemSnoozedBy,
  inboxSnoozesVersion,
} from "@/chat/inbox-snoozes/store";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorConversations,
  juniorInboxItemConversations,
  juniorInboxItems,
  juniorQuestions,
} from "@/db/schema";
import { inboxItemNeedsUser } from "./access";
import {
  inboxItemRequest,
  inboxItemTitle,
  itemQuestion,
} from "./question-content";
import { INBOX_SUBJECT_KINDS, subjectKindPlugin } from "./subjects";

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

/**
 * SQL: the Inbox item needs the User now: `inboxItemNeedsUser`, and the
 * User has not snoozed it.
 */
export function inboxItemNeedsUserNow(userId: string): SQL {
  return and(inboxItemNeedsUser(userId), not(inboxItemSnoozedBy(userId)))!;
}

/**
 * Count the open Inbox items that need a User (`inboxItemNeedsUser`), one
 * row per subject, with the ones that ask with a form as `decisions`,
 * the Automation alerts as `automations`, and the To-dos as `todos`.
 * The nav count and the Inbox bundle counts all read this one query. A
 * snoozed item does not count until it wakes.
 */
export async function countInboxItemsNeedingUserBySubject(
  db: JuniorDatabase,
  userId: string,
): Promise<
  Array<{
    automations: number;
    decisions: number;
    subjectId: string;
    subjectKind: string;
    todos: number;
    total: number;
  }>
> {
  return await db
    .select({
      automations:
        sql<number>`count(*) filter (where ${eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.automation)})`.mapWith(
          Number,
        ),
      decisions:
        sql<number>`count(*) filter (where ${inboxItemRequest} -> 'fields' is not null)`.mapWith(
          Number,
        ),
      subjectId: juniorInboxItems.subjectId,
      subjectKind: juniorInboxItems.subjectKind,
      todos:
        sql<number>`count(*) filter (where ${eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.todo)})`.mapWith(
          Number,
        ),
      total: count(),
    })
    .from(juniorInboxItems)
    .leftJoin(juniorQuestions, itemQuestion)
    .where(inboxItemNeedsUserNow(userId))
    .groupBy(juniorInboxItems.subjectKind, juniorInboxItems.subjectId);
}

/**
 * Return a query for a token that changes when the open Inbox items that
 * need a User change. An item that is added or changed moves the newest
 * `updated_at`, and an item that closes, leaves the User, or is snoozed
 * changes the count. A new or ended snooze also changes the token.
 */
export function inboxItemsNeedingUserVersionQuery(
  db: JuniorDatabase,
  userId: string,
) {
  return db
    .select({
      version: sql<string>`concat_ws(':', count(*), max(${juniorInboxItems.updatedAt}), ${inboxSnoozesVersion(userId)})`,
    })
    .from(juniorInboxItems)
    .where(inboxItemNeedsUserNow(userId));
}

// The root of a linked Conversation. An item that a child agent adds links
// the child, and the feed lists only roots.
const waitingRootId =
  sql<string>`coalesce(${juniorConversations.rootConversationId}, ${juniorInboxItemConversations.conversationId})`.as(
    "waiting_root_id",
  );

// The root of the Conversation that owns a To-do's item. The item links no
// Conversation, so it waits on the person in its owner's tree.
function waitingTodoRootId() {
  return sql<string>`coalesce(${juniorConversations.rootConversationId}, ${inboxItemOwnerConversationId()})`.as(
    "waiting_root_id",
  );
}

/** Open items that need the User now, with the root where each one waits. */
function waitingItemsQuery(db: JuniorDatabase, userId: string) {
  const columns = {
    createdAt: juniorInboxItems.createdAt,
    itemId: juniorInboxItems.id,
    subjectKind: juniorInboxItems.subjectKind,
    title: inboxItemTitle.as("title"),
  };
  return db
    .select({ conversationId: waitingRootId, ...columns })
    .from(juniorInboxItemConversations)
    .innerJoin(
      juniorInboxItems,
      eq(juniorInboxItems.id, juniorInboxItemConversations.itemId),
    )
    .leftJoin(juniorQuestions, itemQuestion)
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
        .select({ conversationId: waitingTodoRootId(), ...columns })
        .from(juniorInboxItems)
        .leftJoin(juniorQuestions, itemQuestion)
        .leftJoin(
          juniorConversations,
          eq(
            juniorConversations.conversationId,
            inboxItemOwnerConversationId(),
          ),
        )
        .where(
          and(
            inboxItemNeedsUserNow(userId),
            eq(juniorInboxItems.subjectKind, INBOX_SUBJECT_KINDS.todo),
          ),
        ),
    );
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
    const plugin = subjectKindPlugin(row.subjectKind);
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
