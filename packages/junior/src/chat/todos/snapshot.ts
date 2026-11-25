import { getSqlExecutor } from "@/chat/db";
import type { CompactionSnapshot } from "@/chat/services/compaction-snapshot";
import { renderTodosSnapshot, TODO_DELTA_TAG } from "@/chat/todos/prompt";
import { listTodos } from "@/chat/todos/store";

/**
 * One `<todos>` snapshot of the open To-dos, read from the database, for a
 * compaction summary, so the To-dos and their version survive the History
 * replacement. It replaces the To-do deltas of the kept Turn contexts.
 */
export const todosCompactionSnapshot: CompactionSnapshot = {
  replacedTags: [TODO_DELTA_TAG],
  async load(conversationId) {
    return renderTodosSnapshot(
      await listTodos(getSqlExecutor(), conversationId),
    );
  },
};
