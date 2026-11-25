import { getSqlExecutor } from "@/chat/db";
import type { TurnContextSource } from "@/chat/agent/prompt";
import {
  latestSeenTodosVersion,
  renderTodoDelta,
  renderTodosReview,
} from "./prompt";
import { listTodos } from "./store";

/**
 * Read the To-dos of a Conversation for the Turn context of a new prompt. It
 * shows the changes that others made after the To-do version that the
 * history shows, else every open To-do when the history has not shown the
 * To-dos for a while. The model's own changes are in its tool results.
 */
export const loadTodosTurnContext: TurnContextSource = async (
  conversationId,
) => {
  const todos = await listTodos(getSqlExecutor(), conversationId);
  return (history) =>
    renderTodoDelta(todos, latestSeenTodosVersion(history)) ??
    renderTodosReview(todos, history);
};
