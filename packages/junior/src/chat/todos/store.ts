/**
 * Durable To-dos of a Conversation. The list's own agent changes them with
 * `updateTodos`; a person can change a status in the dashboard. A child
 * agent can close the To-dos assigned to it, and a read closes the rest
 * once the child's result has reached this Conversation. Each
 * change takes a new version from one global sequence, so the next Turn can
 * show the model only the changes that it has not seen.
 */
import { childWorkGoesOn } from "@/chat/agent-invocations/parent-result";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorDatabase, JuniorSqlDatabase } from "@/db/db";
import {
  juniorAgentBindings,
  juniorTodos,
  juniorTodoVersionSeq,
  juniorUsers,
} from "@/db/schema";
import { isEventMailboxMetadata } from "@/chat/events/notification";
import { readInboundMessageSender } from "@/chat/task-execution/message-sender";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { mapBounded } from "@/chat/fan-out";
import { syncInboxItemPush } from "@/chat/notifications/inbox-item-push";
import { ToolInputError } from "@/chat/tool-support/tool-input-error";
import { syncTodoInboxItems } from "./inbox-items";
import { todoRef } from "./tool-output";
import {
  isOpenTodoStatus,
  OPEN_TODO_STATUSES,
  type ClosedTodoStatus,
  type Todo,
  type TodoStatus,
} from "./types";

const TODOS_LOCK_PREFIX = "junior:todos";

/** Where a stored assignee points: a Conversation's agent or a User. */
export type StoredTodoAssignee =
  | { conversationId: string }
  | { userId: string };

/** Fields of a new To-do. */
export interface NewTodo {
  title: string;
  notes?: string | undefined;
  status: TodoStatus;
  assignee: StoredTodoAssignee;
}

/** Changes to one To-do. `notes: null` clears the notes. */
export interface TodoUpdate {
  id: number;
  title?: string | undefined;
  notes?: string | null | undefined;
  status?: TodoStatus | undefined;
  assignee?: StoredTodoAssignee | undefined;
}

/** One batch of agent changes, applied in one transaction. */
export interface TodoChange {
  add: NewTodo[];
  update: TodoUpdate[];
  remove: number[];
}

type TodoRow = typeof juniorTodos.$inferSelect;

function nextVersion() {
  return sql<number>`nextval(${juniorTodoVersionSeq.seqName}::regclass)`;
}

function assigneeColumns(assignee: StoredTodoAssignee) {
  return "userId" in assignee
    ? { assigneeConversationId: null, assigneeUserId: assignee.userId }
    : { assigneeConversationId: assignee.conversationId, assigneeUserId: null };
}

function requireKnownIds(rows: Map<number, TodoRow>, ids: number[]) {
  const unknown = ids.filter((id) => !rows.has(id));
  if (unknown.length > 0) {
    throw new ToolInputError(
      `No To-do has id ${unknown.map(todoRef).join(", ")}. Call updateTodos with no changes to list the open To-dos.`,
    );
  }
}

/** Check that each id is known and changes once. */
function validateChange(rows: Map<number, TodoRow>, change: TodoChange) {
  const touched = [...change.update.map((todo) => todo.id), ...change.remove];
  requireKnownIds(rows, touched);
  if (new Set(touched).size !== touched.length) {
    throw new ToolInputError(
      "Change each To-do once per call: an id is in more than one update or remove.",
    );
  }
}

// A Drizzle transaction, not `executor.transaction`: the Inbox item writes
// of `syncTodoInboxItems` open their own transactions, which nest as
// savepoints only inside a Drizzle one. Call it outside an executor
// transaction. `sync` syncs the Conversation's To-do items in the
// transaction. The items that it added or changed push after the commit,
// because the push reads them outside the transaction.
async function withTodosLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: (
    db: JuniorDatabase,
    sync: (nowMs: number) => Promise<void>,
  ) => Promise<T>,
): Promise<T> {
  let itemIds: string[] = [];
  const result = await executor.db().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`${TODOS_LOCK_PREFIX}:${conversationId}`}))`,
    );
    return await callback(tx, async (nowMs) => {
      itemIds = await syncTodoInboxItems(tx, { conversationId, nowMs });
    });
  });
  await mapBounded(itemIds, (itemId) => syncInboxItemPush(itemId));
  return result;
}

/**
 * Apply one batch of changes from the list's own agent. Return the To-dos it
 * added or updated, and the To-dos whose status a person set last and the
 * change replaced, as they were before it. Throws `ToolInputError` for an
 * unknown id or an id that changes twice.
 */
export async function changeTodos(
  executor: JuniorSqlDatabase,
  args: { conversationId: string; change: TodoChange; nowMs: number },
): Promise<{ todos: Todo[]; replacedPersonChanges: Todo[] }> {
  const { change, conversationId } = args;
  const now = new Date(args.nowMs);
  return await withTodosLock(executor, conversationId, async (db, sync) => {
    const rows = new Map(
      (
        await db
          .select()
          .from(juniorTodos)
          .where(eq(juniorTodos.conversationId, conversationId))
      ).map((row) => [row.id, row]),
    );
    validateChange(rows, change);
    // A person can change a status during a Turn, after the Turn context
    // showed the To-dos. The agent's change wins, and its result shows what it
    // replaced, since no later `<todo-delta>` can.
    const replacedIds = change.update
      .filter((update) => {
        const row = rows.get(update.id)!;
        return (
          row.changedByUserId !== null &&
          update.status !== undefined &&
          update.status !== row.status
        );
      })
      .map((update) => update.id);
    const replacedPersonChanges =
      replacedIds.length > 0
        ? (await readTodos(db, conversationId)).filter((todo) =>
            replacedIds.includes(todo.id),
          )
        : [];
    if (change.remove.length > 0) {
      await db
        .delete(juniorTodos)
        .where(
          and(
            eq(juniorTodos.conversationId, conversationId),
            inArray(juniorTodos.id, change.remove),
          ),
        );
    }
    const changedIds: number[] = [];
    /* oxlint-disable no-await-in-loop -- Writes share one transaction. */
    for (const update of change.update) {
      await db
        .update(juniorTodos)
        .set({
          ...(update.title !== undefined ? { title: update.title } : undefined),
          ...(update.notes !== undefined ? { notes: update.notes } : undefined),
          ...(update.status ? { status: update.status } : undefined),
          ...(update.assignee ? assigneeColumns(update.assignee) : undefined),
          changedByUserId: null,
          changedByConversationId: null,
          updatedAt: now,
          version: nextVersion(),
        })
        .where(
          and(
            eq(juniorTodos.conversationId, conversationId),
            eq(juniorTodos.id, update.id),
          ),
        );
      changedIds.push(update.id);
    }
    /* oxlint-enable no-await-in-loop */
    // Insert one at a time, so ids follow the order of `add`.
    /* oxlint-disable no-await-in-loop -- Insert one at a time so ids follow the order of add. */
    for (const todo of change.add) {
      const [inserted] = await db
        .insert(juniorTodos)
        .values({
          conversationId,
          id: nextVersion(),
          title: todo.title,
          notes: todo.notes ?? null,
          status: todo.status,
          ...assigneeColumns(todo.assignee),
          version: nextVersion(),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: juniorTodos.id });
      changedIds.push(inserted!.id);
    }
    /* oxlint-enable no-await-in-loop */
    await sync(args.nowMs);
    // Open detail views of the Conversation reload the To-dos on this bump.
    await touchConversationDetail(db, [conversationId]);
    const todos = await readTodos(db, conversationId);
    return {
      todos: changedIds.flatMap(
        (id) => todos.find((todo) => todo.id === id) ?? [],
      ),
      replacedPersonChanges,
    };
  });
}

/**
 * Set the status of one To-do for a person, and return the To-do. Returns
 * undefined when the Conversation has no such To-do. With `assignedOnly`,
 * the To-do must still be open and assigned to the person when the change
 * applies under the lock, so Done on a stale Inbox item cannot close a
 * To-do that the agent gave to someone else.
 */
export async function setTodoStatusByUser(
  executor: JuniorSqlDatabase,
  args: {
    assignedOnly?: boolean;
    conversationId: string;
    id: number;
    nowMs: number;
    status: TodoStatus;
    userId: string;
  },
): Promise<Todo | undefined> {
  const { conversationId } = args;
  return await withTodosLock(executor, conversationId, async (db, sync) => {
    const updated = await db
      .update(juniorTodos)
      .set({
        status: args.status,
        changedByUserId: args.userId,
        changedByConversationId: null,
        updatedAt: new Date(args.nowMs),
        version: nextVersion(),
      })
      .where(
        and(
          eq(juniorTodos.conversationId, conversationId),
          eq(juniorTodos.id, args.id),
          args.assignedOnly
            ? and(
                eq(juniorTodos.assigneeUserId, args.userId),
                inArray(juniorTodos.status, [...OPEN_TODO_STATUSES]),
              )
            : undefined,
        ),
      )
      .returning({ id: juniorTodos.id });
    if (updated.length === 0) return undefined;
    await sync(args.nowMs);
    await touchConversationDetail(db, [conversationId]);
    const todos = await readTodos(db, conversationId);
    return todos.find((todo) => todo.id === args.id);
  });
}

/**
 * Close To-dos of one Conversation that are assigned to one of its child
 * agents, for that child. Each change names the child, so the parent sees it
 * in its next `<todo-delta>`. Returns the changed To-dos.
 */
async function closeChildTodos(
  db: JuniorDatabase,
  args: {
    childConversationId: string;
    conversationId: string;
    nowMs: number;
    statuses: ReadonlyMap<number, ClosedTodoStatus>;
  },
): Promise<Todo[]> {
  const ids = [...args.statuses.keys()];
  if (ids.length === 0) return [];
  /* oxlint-disable no-await-in-loop -- Writes share one transaction. */
  for (const [id, status] of args.statuses) {
    await db
      .update(juniorTodos)
      .set({
        status,
        changedByUserId: null,
        changedByConversationId: args.childConversationId,
        updatedAt: new Date(args.nowMs),
        version: nextVersion(),
      })
      .where(
        and(
          eq(juniorTodos.conversationId, args.conversationId),
          eq(juniorTodos.id, id),
        ),
      );
  }
  /* oxlint-enable no-await-in-loop */
  await touchConversationDetail(db, [args.conversationId]);
  return (await readTodos(db, args.conversationId)).filter((todo) =>
    ids.includes(todo.id),
  );
}

/**
 * List the ids of To-dos assigned to one Conversation in other lists. Only a
 * parent can assign a To-do to a Conversation, so they are its parent's.
 */
export async function listParentTodoIds(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<Set<number>> {
  const rows = await executor
    .db()
    .select({ id: juniorTodos.id })
    .from(juniorTodos)
    .where(
      and(
        eq(juniorTodos.assigneeConversationId, conversationId),
        ne(juniorTodos.conversationId, conversationId),
      ),
    );
  return new Set(rows.map((row) => row.id));
}

/**
 * Close To-dos of the parent that are assigned to the calling child agent.
 * Throws `ToolInputError` for an id that the parent did not assign to it.
 */
export async function closeTodosForChild(
  executor: JuniorSqlDatabase,
  args: {
    childConversationId: string;
    nowMs: number;
    statuses: ReadonlyMap<number, ClosedTodoStatus>;
  },
): Promise<Todo[]> {
  const ids = [...args.statuses.keys()];
  const assigned = and(
    inArray(juniorTodos.id, ids),
    eq(juniorTodos.assigneeConversationId, args.childConversationId),
    ne(juniorTodos.conversationId, args.childConversationId),
  );
  const [owner] = await executor
    .db()
    .selectDistinct({ conversationId: juniorTodos.conversationId })
    .from(juniorTodos)
    .where(assigned);
  if (!owner) return rejectUnassigned(ids);
  return await withTodosLock(executor, owner.conversationId, async (db) => {
    const rows = await db
      .select({ id: juniorTodos.id })
      .from(juniorTodos)
      .where(
        and(eq(juniorTodos.conversationId, owner.conversationId), assigned),
      );
    const found = new Set(rows.map((row) => row.id));
    const others = ids.filter((id) => !found.has(id));
    if (others.length > 0) return rejectUnassigned(others);
    return await closeChildTodos(db, {
      childConversationId: args.childConversationId,
      conversationId: owner.conversationId,
      nowMs: args.nowMs,
      statuses: args.statuses,
    });
  });
}

function rejectUnassigned(ids: readonly number[]): never {
  throw new ToolInputError(
    `Your parent did not assign ${ids.map(todoRef).join(", ")} to you. You can only set your own To-dos of the parent to done or dropped.`,
  );
}

/** A child's result that reached a Conversation: who sent it, how it ended, and when. */
type ReceivedChildResult = {
  atMs: number;
  childConversationId: string;
  status: ClosedTodoStatus;
};

/**
 * Read the child results that wait in a Conversation's mailbox. A done
 * result closes the child's To-dos as done, and a stopped one drops them.
 * A Turn reads its To-dos when it builds its prompt, before it takes its
 * input out of the mailbox, so a read sees every result there.
 */
async function readReceivedChildResults(
  conversationId: string,
): Promise<ReceivedChildResult[]> {
  const work = await getConversationWorkState({ conversationId });
  return (work?.execution.pendingMessages ?? []).flatMap((message) => {
    const sender = readInboundMessageSender(message);
    const metadata = message.input.metadata;
    const result = isEventMailboxMetadata(metadata)
      ? metadata.event.status
      : undefined;
    const status =
      result === "done" ? "done" : result === "stopped" ? "dropped" : undefined;
    return sender && status
      ? [
          {
            atMs: message.createdAtMs,
            childConversationId: sender.conversationId,
            status,
          },
        ]
      : [];
  });
}

/**
 * Close the open To-dos of a Conversation whose child's result reached it
 * after the To-do last changed: done when the child completed, dropped when
 * it was stopped. The received results decide it, so a repeat read changes
 * nothing.
 */
async function settleChildTodos(
  executor: JuniorSqlDatabase,
  conversationId: string,
  todos: readonly Todo[],
): Promise<boolean> {
  const assigned = todos.filter(
    (todo) => todo.assignee.kind === "agent" && isOpenTodoStatus(todo.status),
  );
  if (assigned.length === 0) return false;
  const results = await readReceivedChildResults(conversationId);
  if (results.length === 0) return false;
  const byChild = new Map<string, Map<number, ClosedTodoStatus>>();
  const doneChildren = new Set<string>();
  for (const todo of assigned) {
    if (todo.assignee.kind !== "agent") continue;
    const childId = todo.assignee.conversationId;
    // The newest result after the To-do's last change decides it. A To-do
    // given to a child after its result waits for the next one.
    const latest = results
      .filter(
        (result) =>
          result.childConversationId === childId &&
          result.atMs > todo.updatedAtMs,
      )
      .reduce<ReceivedChildResult | undefined>(
        (newest, result) =>
          !newest || result.atMs >= newest.atMs ? result : newest,
        undefined,
      );
    if (!latest) continue;
    if (latest.status === "done") doneChildren.add(childId);
    const statuses =
      byChild.get(childId) ?? new Map<number, ClosedTodoStatus>();
    statuses.set(todo.id, latest.status);
    byChild.set(childId, statuses);
  }
  // A child that finished a Turn while its work goes on, such as a Watch on
  // a pull request, keeps its To-dos until a result after its work ends.
  const goesOn = await mapBounded([...doneChildren], async (childId) =>
    (await childWorkGoesOn(childId)) ? childId : undefined,
  );
  for (const childId of goesOn) {
    if (childId) byChild.delete(childId);
  }
  if (byChild.size === 0) return false;
  const nowMs = Date.now();
  await withTodosLock(executor, conversationId, async (db) => {
    // Close only To-dos that no change replaced since the read.
    const current = new Map(
      (await readTodos(db, conversationId)).map((todo) => [
        todo.id,
        todo.version,
      ]),
    );
    /* oxlint-disable no-await-in-loop -- Writes share one transaction. */
    for (const [childConversationId, statuses] of byChild) {
      const unchanged = new Map(
        [...statuses].filter(
          ([id]) =>
            current.get(id) === todos.find((todo) => todo.id === id)?.version,
        ),
      );
      await closeChildTodos(db, {
        childConversationId,
        conversationId,
        nowMs,
        statuses: unchanged,
      });
    }
    /* oxlint-enable no-await-in-loop */
  });
  return true;
}

/**
 * List every To-do of one Conversation, oldest first, with assignees
 * resolved. A To-do assigned to a child agent that has finished or stopped
 * since it last changed is closed first.
 */
export async function listTodos(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<Todo[]> {
  const todos = await readTodos(executor.db(), conversationId);
  return (await settleChildTodos(executor, conversationId, todos))
    ? await readTodos(executor.db(), conversationId)
    : todos;
}

async function readTodos(
  db: JuniorDatabase,
  conversationId: string,
): Promise<Todo[]> {
  const assignedUser = alias(juniorUsers, "assigned_user");
  const changedByUser = alias(juniorUsers, "changed_by_user");
  const changedByAgent = alias(juniorAgentBindings, "changed_by_agent");
  const rows = await db
    .select({
      todo: juniorTodos,
      agentName: juniorAgentBindings.name,
      assignedUserEmail: assignedUser.primaryEmail,
      assignedUserName: assignedUser.displayName,
      changedByEmail: changedByUser.primaryEmail,
      changedByName: changedByUser.displayName,
      changedByAgentName: changedByAgent.name,
    })
    .from(juniorTodos)
    .leftJoin(
      juniorAgentBindings,
      and(
        eq(juniorAgentBindings.parentConversationId, conversationId),
        eq(
          juniorAgentBindings.childConversationId,
          juniorTodos.assigneeConversationId,
        ),
      ),
    )
    .leftJoin(assignedUser, eq(assignedUser.id, juniorTodos.assigneeUserId))
    .leftJoin(changedByUser, eq(changedByUser.id, juniorTodos.changedByUserId))
    .leftJoin(
      changedByAgent,
      and(
        eq(changedByAgent.parentConversationId, conversationId),
        eq(
          changedByAgent.childConversationId,
          juniorTodos.changedByConversationId,
        ),
      ),
    )
    .where(eq(juniorTodos.conversationId, conversationId))
    .orderBy(asc(juniorTodos.id));
  return rows.map(
    ({
      todo,
      agentName,
      assignedUserEmail,
      assignedUserName,
      changedByEmail,
      changedByName,
      changedByAgentName,
    }) => ({
      id: todo.id,
      title: todo.title,
      ...(todo.notes ? { notes: todo.notes } : undefined),
      status: todo.status,
      assignee: todo.assigneeUserId
        ? {
            kind: "user" as const,
            userId: todo.assigneeUserId,
            // The foreign key keeps the User while the To-do points to it.
            email: assignedUserEmail ?? "",
            ...(assignedUserName ? { name: assignedUserName } : undefined),
          }
        : (todo.assigneeConversationId ?? conversationId) === conversationId
          ? { kind: "self" as const }
          : {
              kind: "agent" as const,
              conversationId: todo.assigneeConversationId!,
              ...(agentName ? { name: agentName } : undefined),
            },
      version: todo.version,
      ...(todo.changedByUserId
        ? {
            changedBy: {
              userId: todo.changedByUserId,
              email: changedByEmail ?? "",
              ...(changedByName ? { name: changedByName } : undefined),
            },
          }
        : undefined),
      ...(todo.changedByConversationId
        ? {
            changedByAgent: {
              conversationId: todo.changedByConversationId,
              ...(changedByAgentName
                ? { name: changedByAgentName }
                : undefined),
            },
          }
        : undefined),
      createdAtMs: todo.createdAt.getTime(),
      updatedAtMs: todo.updatedAt.getTime(),
    }),
  );
}

/** Delete the To-dos of purged Conversations. Titles and notes are content. */
export async function deleteTodos(
  executor: JuniorSqlDatabase,
  conversationIds: string[],
): Promise<void> {
  if (conversationIds.length === 0) return;
  await executor
    .db()
    .delete(juniorTodos)
    .where(inArray(juniorTodos.conversationId, conversationIds));
}
