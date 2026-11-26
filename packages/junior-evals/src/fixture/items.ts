/**
 * What the agent left for people in one Conversation: its action items and
 * its To-dos. Tests read them through the runtime's stores, so a `codemode`
 * call, whose input the results do not show, counts too.
 */
import { getDb, getSqlExecutor } from "@/chat/db";
import { listReplyActionItems } from "@/chat/inbox-items/store";
import { listTodos } from "@/chat/todos/store";
import type { Todo } from "@/chat/todos/types";

/** The questions that the agent asks in the Conversation's open action items. */
export async function readAskedRequests(
  conversationId: string,
): Promise<unknown[]> {
  return (await listReplyActionItems(getDb(), conversationId)).flatMap((item) =>
    item.request ? [item.request] : [],
  );
}

/** The open To-dos of the Conversation that are assigned to a person. */
export async function readTodosForPeople(
  conversationId: string,
): Promise<Todo[]> {
  return (await listTodos(getSqlExecutor(), conversationId)).filter(
    (todo) =>
      todo.assignee.kind === "user" &&
      (todo.status === "open" || todo.status === "in_progress"),
  );
}
