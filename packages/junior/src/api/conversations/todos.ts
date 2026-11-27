import type { User } from "@sentry/junior-plugin-api";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { listTodos, setTodoStatusByUser } from "@/chat/todos/store";
import { isOpenTodoStatus, type Todo } from "@/chat/todos/types";
import { throwApiError } from "../http";
import {
  type ConversationTodo,
  type ConversationTodosReport,
  type TodoStatusBody,
} from "../schema/todos";
import { readConversationAccessFromSql } from "./access";

/** Closed To-dos that the report shows after the open ones. */
const RECENT_CLOSED_TODOS = 5;

function reportTodo(
  todo: Todo,
  canViewPrivateContent: boolean,
  viewer: User | undefined,
): ConversationTodo {
  const { assignee } = todo;
  const forViewer =
    assignee.kind === "user" &&
    viewer !== undefined &&
    assignee.userId === viewer.id
      ? { viewer: true as const }
      : undefined;
  return {
    id: todo.id,
    status: todo.status,
    updatedAt: new Date(todo.updatedAtMs).toISOString(),
    ...(canViewPrivateContent
      ? {
          title: todo.title,
          ...(todo.notes ? { notes: todo.notes } : undefined),
          assignee:
            assignee.kind === "user"
              ? {
                  kind: "user",
                  name: assignee.name ?? assignee.email,
                  ...forViewer,
                }
              : assignee,
          ...(todo.changedBy
            ? { changedBy: todo.changedBy.name ?? todo.changedBy.email }
            : todo.changedByAgent?.name
              ? { changedBy: todo.changedByAgent.name }
              : undefined),
        }
      : {
          assignee:
            assignee.kind === "agent"
              ? { kind: "agent", conversationId: assignee.conversationId }
              : assignee.kind === "user"
                ? { kind: "user", ...forViewer }
                : { kind: assignee.kind },
          redacted: true as const,
        }),
  };
}

/**
 * Load the To-dos of one Conversation: every open To-do, then the latest
 * closed ones. Throws a standard API not-found error. Viewers who cannot see
 * private content get no titles, notes, or names.
 */
export async function requireConversationTodos(
  conversationId: string,
  options: { viewer?: User | undefined } = {},
): Promise<ConversationTodosReport> {
  const conversation = await getConversationStore().get({ conversationId });
  if (!conversation) throwApiError(404, "Conversation not found.");

  const [accessByConversation, todos] = await Promise.all([
    readConversationAccessFromSql(getDb(), [conversationId], options.viewer),
    listTodos(getSqlExecutor(), conversationId),
  ]);
  const canViewPrivateContent =
    accessByConversation.get(conversationId)?.canViewPrivateContent ?? false;
  const closed = todos
    .filter((todo) => !isOpenTodoStatus(todo.status))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
    .slice(0, RECENT_CLOSED_TODOS);
  return {
    conversationId,
    todos: [
      ...todos.filter((todo) => isOpenTodoStatus(todo.status)),
      ...closed,
    ].map((todo) => reportTodo(todo, canViewPrivateContent, options.viewer)),
  };
}

/**
 * Set the status of one To-do for a person. The To-dos are shared, so only
 * a Participant can change them, the same as the title. The agent sees the
 * change in a To-do delta on its next Turn.
 */
export async function setConversationTodoStatus(
  viewer: User,
  conversationId: string,
  todoId: number,
  body: TodoStatusBody,
): Promise<ConversationTodo> {
  const access = await readConversationAccessFromSql(
    getDb(),
    [conversationId],
    viewer,
  );
  const conversationAccess = access.get(conversationId);
  if (!conversationAccess?.isParticipant) {
    throwApiError(404, "Conversation not found.");
  }
  const todo = await setTodoStatusByUser(getSqlExecutor(), {
    conversationId,
    id: todoId,
    nowMs: Date.now(),
    status: body.status,
    userId: viewer.id,
  });
  if (!todo) throwApiError(404, "To-do not found.");
  return reportTodo(todo, conversationAccess.canViewPrivateContent, viewer);
}
