/**
 * Durable To-dos of a Conversation. The list's own agent changes them with
 * `updateTodos`; a person can change a status in the dashboard. Each
 * change takes a new version from one global sequence, so the next Turn can
 * show the model only the changes that it has not seen.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { JuniorSqlDatabase } from "@/db/db";
import {
  juniorAgentBindings,
  juniorTodos,
  juniorTodoVersionSeq,
  juniorUsers,
} from "@/db/schema";
import { touchConversationDetail } from "@/chat/conversations/sql/detail-version";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";
import { todoRef } from "./tool-output";
import type { Todo, TodoStatus } from "./types";

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

async function withTodosLock<T>(
  executor: JuniorSqlDatabase,
  conversationId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return await executor.withLock(
    `${TODOS_LOCK_PREFIX}:${conversationId}`,
    async () => await executor.transaction(callback),
  );
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
  return await withTodosLock(executor, conversationId, async () => {
    const db = executor.db();
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
        ? (await listTodos(executor, conversationId)).filter((todo) =>
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
    // Open detail views of the Conversation reload the To-dos on this bump.
    await touchConversationDetail(db, [conversationId]);
    const todos = await listTodos(executor, conversationId);
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
 * undefined when the Conversation has no such To-do.
 */
export async function setTodoStatusByUser(
  executor: JuniorSqlDatabase,
  args: {
    conversationId: string;
    id: number;
    nowMs: number;
    status: TodoStatus;
    userId: string;
  },
): Promise<Todo | undefined> {
  return await withTodosLock(executor, args.conversationId, async () => {
    const updated = await executor
      .db()
      .update(juniorTodos)
      .set({
        status: args.status,
        changedByUserId: args.userId,
        updatedAt: new Date(args.nowMs),
        version: nextVersion(),
      })
      .where(
        and(
          eq(juniorTodos.conversationId, args.conversationId),
          eq(juniorTodos.id, args.id),
        ),
      )
      .returning({ id: juniorTodos.id });
    if (updated.length === 0) return undefined;
    await touchConversationDetail(executor.db(), [args.conversationId]);
    const todos = await listTodos(executor, args.conversationId);
    return todos.find((todo) => todo.id === args.id);
  });
}

/** List every To-do of one Conversation, oldest first, with assignees resolved. */
export async function listTodos(
  executor: JuniorSqlDatabase,
  conversationId: string,
): Promise<Todo[]> {
  const assignedUser = alias(juniorUsers, "assigned_user");
  const changedByUser = alias(juniorUsers, "changed_by_user");
  const rows = await executor
    .db()
    .select({
      todo: juniorTodos,
      agentName: juniorAgentBindings.name,
      assignedUserEmail: assignedUser.primaryEmail,
      assignedUserName: assignedUser.displayName,
      changedByEmail: changedByUser.primaryEmail,
      changedByName: changedByUser.displayName,
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
