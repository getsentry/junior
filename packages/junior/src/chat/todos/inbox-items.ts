/**
 * A To-do for a person shows in that person's Inbox as an action item that
 * core owns, the way an Automation alert does. The To-do is the record; the
 * item follows it. Each To-do change syncs the items of its Conversation in
 * the same transaction, so the Inbox never shows a To-do that closed.
 *
 * The item is private and links no Conversation, so only its assignee sees
 * it: no other person, no agent, and no Slack thread. The Conversation owns
 * it, so it stacks under the Conversation's root and the Conversation's
 * tree waits on the person (`needs_you`). The shared status does not
 * change. An assignee who cannot see the
 * Conversation's content gets no item.
 */
import { and, eq, inArray, like } from "drizzle-orm";
import {
  conversationAccessFromRows,
  readConversationAccessRows,
  type ProviderTenant,
} from "@/api/conversations/access";
import { conversationIdsWithParticipantUser } from "@/api/conversations/membership";
import { TODO_INBOX_ITEM_KEY_PREFIX } from "@/chat/inbox-items/access";
import {
  closeInboxItem,
  insertInboxItem,
  updateInboxItemContent,
  type InboxItemContent,
} from "@/chat/inbox-items/store";
import type { JuniorDatabase } from "@/db/db";
import {
  juniorInboxItemAssignees,
  juniorInboxItems,
  juniorTodos,
} from "@/db/schema";
import { isOpenTodoStatus } from "./types";

/** The dedupe key of the Inbox item of one To-do. */
export function todoInboxItemKey(
  conversationId: string,
  todoId: number,
): string {
  return `${TODO_INBOX_ITEM_KEY_PREFIX}${conversationId}:${todoId}`;
}

type TodoRow = Pick<
  typeof juniorTodos.$inferSelect,
  "assigneeUserId" | "changedByUserId" | "id" | "notes" | "status" | "title"
>;

/** Why the item of a To-do that is still open, or that is gone, closed. */
function closeReason(todo: TodoRow | undefined): string | undefined {
  if (!todo) return "The To-do was removed.";
  if (todo.status === "done") return undefined;
  if (todo.status === "dropped") return "The To-do was dropped.";
  return "The To-do is no longer assigned to you.";
}

/**
 * Add, change, or close the Inbox items of one Conversation's To-dos, to
 * match the To-dos now. Each open To-do for a person who can see the
 * Conversation has one open item. Call it inside the transaction of each
 * To-do change, under the To-do lock. It writes nothing when the items are
 * already right. Return the ids of the open items that it added or changed,
 * so the caller can push them after the transaction commits.
 */
export async function syncTodoInboxItems(
  db: JuniorDatabase,
  args: { conversationId: string; nowMs: number },
): Promise<string[]> {
  const { conversationId, nowMs } = args;
  const todos = await db
    .select({
      assigneeUserId: juniorTodos.assigneeUserId,
      changedByUserId: juniorTodos.changedByUserId,
      id: juniorTodos.id,
      notes: juniorTodos.notes,
      status: juniorTodos.status,
      title: juniorTodos.title,
    })
    .from(juniorTodos)
    .where(eq(juniorTodos.conversationId, conversationId));
  const openItems = await db
    .select({
      body: juniorInboxItems.body,
      dedupeKey: juniorInboxItems.dedupeKey,
      id: juniorInboxItems.id,
      title: juniorInboxItems.title,
    })
    .from(juniorInboxItems)
    .where(
      and(
        eq(juniorInboxItems.ownerKind, "conversation"),
        eq(juniorInboxItems.ownerId, conversationId),
        eq(juniorInboxItems.status, "open"),
        like(juniorInboxItems.dedupeKey, `${TODO_INBOX_ITEM_KEY_PREFIX}%`),
      ),
    );
  const assigneeOf = new Map(
    openItems.length === 0
      ? []
      : (
          await db
            .select({
              itemId: juniorInboxItemAssignees.itemId,
              userId: juniorInboxItemAssignees.userId,
            })
            .from(juniorInboxItemAssignees)
            .where(
              inArray(
                juniorInboxItemAssignees.itemId,
                openItems.map((item) => item.id),
              ),
            )
        ).map((row) => [row.itemId, row.userId]),
  );
  const itemByKey = new Map(openItems.map((item) => [item.dedupeKey, item]));
  const todoByKey = new Map(
    todos.map((todo) => [todoInboxItemKey(conversationId, todo.id), todo]),
  );

  // Each person's access to the Conversation, read once.
  const people = [
    ...new Set(
      todos.flatMap((todo) =>
        isOpenTodoStatus(todo.status) && todo.assigneeUserId
          ? [todo.assigneeUserId]
          : [],
      ),
    ),
  ];
  const canSee = new Map<string, boolean>();
  const accessRows =
    people.length > 0
      ? await readConversationAccessRows(db, [conversationId])
      : [];
  let tenant: ProviderTenant | undefined;
  const shown: string[] = [];
  /* oxlint-disable no-await-in-loop -- Reads share one transaction; a list has few people. */
  for (const userId of people) {
    const participantRoots = await conversationIdsWithParticipantUser(
      db,
      accessRows.flatMap((row) => [
        row.conversationId,
        ...(row.storedRootConversationId ? [row.storedRootConversationId] : []),
      ]),
      userId,
    );
    const access = conversationAccessFromRows(accessRows, participantRoots).get(
      conversationId,
    );
    canSee.set(userId, access?.canViewPrivateContent ?? false);
    tenant = access?.tenant;
  }

  for (const [key, todo] of todoByKey) {
    const item = itemByKey.get(key);
    const userId =
      isOpenTodoStatus(todo.status) && todo.assigneeUserId
        ? todo.assigneeUserId
        : undefined;
    if (!userId || !canSee.get(userId)) {
      if (item) {
        await closeInboxItem(db, {
          id: item.id,
          nowMs,
          status: todo.status === "done" ? "done" : "dismissed",
          ...(todo.changedByUserId && !isOpenTodoStatus(todo.status)
            ? { closedByUserId: todo.changedByUserId }
            : undefined),
          reason: closeReason(todo),
        });
      }
      continue;
    }
    const content: InboxItemContent = {
      assignedToEveryone: false,
      assigneeUserIds: [userId],
      body: todo.notes ?? "",
      conversationIds: [],
      kind: "action",
      title: todo.title,
      visibility: "private",
    };
    if (!item) {
      const inserted = await insertInboxItem(db, {
        ...content,
        dedupeKey: key,
        nowMs,
        owner: { id: conversationId, kind: "conversation" },
        ...(tenant ? { tenant } : undefined),
      });
      if (inserted) shown.push(inserted.id);
    } else if (
      item.title !== content.title ||
      item.body !== content.body ||
      assigneeOf.get(item.id) !== userId
    ) {
      await updateInboxItemContent(db, { ...content, id: item.id, nowMs });
      shown.push(item.id);
    }
  }
  for (const item of openItems) {
    if (todoByKey.has(item.dedupeKey)) continue;
    await closeInboxItem(db, {
      id: item.id,
      nowMs,
      reason: closeReason(undefined),
      status: "dismissed",
    });
  }
  /* oxlint-enable no-await-in-loop */
  return shown;
}
