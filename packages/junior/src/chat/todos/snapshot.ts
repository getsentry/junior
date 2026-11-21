import { getSqlExecutor } from "@/chat/db";
import { renderTodosSnapshot } from "@/chat/todos/prompt";
import { listTodos } from "@/chat/todos/store";

/**
 * Append one `<todos>` snapshot of the open To-dos, read from the database,
 * to a compaction summary, so the To-dos and their version survive the history
 * replacement.
 */
export async function appendTodosSnapshot(
  summaryText: string,
  conversationId: string,
): Promise<string> {
  const snapshot = renderTodosSnapshot(
    await listTodos(getSqlExecutor(), conversationId),
  );
  return snapshot ? `${summaryText}\n\n${snapshot}` : summaryText;
}
