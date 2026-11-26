import type { ParentAgentField } from "@sentry/junior-plugin-api";
import * as z from "zod";
import { getSqlExecutor } from "@/chat/db";
import { renderTodoAssignee } from "./prompt";
import { listTodos } from "./store";
import { outputTodo, todoOutputSchema } from "./tool-output";
import {
  isOpenTodoStatus,
  SELF_TODO_ASSIGNEE,
  UPDATE_TODOS_TOOL_NAME,
  type Todo,
} from "./types";

/**
 * Render a parent's To-do for its child: "self" is the child, and
 * "parent" is the parent's own agent.
 */
function parentTodo(todo: Todo, conversationId: string) {
  const { assignee } = todo;
  if (assignee.kind === "self") {
    return outputTodo(todo, "parent");
  }
  if (assignee.kind === "agent" && assignee.conversationId === conversationId) {
    return outputTodo(todo, SELF_TODO_ASSIGNEE);
  }
  return outputTodo(todo, renderTodoAssignee(assignee));
}

/**
 * The open To-dos of the parent in its child's team listing. A child can
 * only close its own.
 */
export const parentTodosField: ParentAgentField = {
  description: "the parent's open To-dos",
  schema: z
    .array(todoOutputSchema)
    .describe(
      `Open To-dos of the parent. Only on the parent. Assignee self is this conversation, which can set those to done or dropped with ${UPDATE_TODOS_TOOL_NAME}; parent is the parent's own agent.`,
    ),
  async load({ conversationId, parentConversationId }) {
    const todos = (await listTodos(getSqlExecutor(), parentConversationId))
      .filter((todo) => isOpenTodoStatus(todo.status))
      .map((todo) => parentTodo(todo, conversationId));
    return todos.length > 0 ? todos : undefined;
  },
};
