/**
 * How the model sees its To-dos, Lore-style: the model's own
 * `todos_updateTodos` calls are already in history, so they get no
 * contribution. A Turn context gets a delta only for changes that others
 * made since the highest version that history shows. Compaction folds it
 * all into one snapshot of the open To-dos. A Turn context also gets a
 * review of the open To-dos when history has not shown them for a few
 * Turns, so stale To-dos get closed. Each starts with that version, and
 * later deltas build on it. Each one is a contribution of the To-do
 * registration, which the host escapes.
 */
import type { PromptHistoryMessage } from "@sentry/junior-plugin-api";
import { todoRef } from "./tool-output";
import {
  isOpenTodoStatus,
  SELF_TODO_ASSIGNEE,
  UPDATE_TODOS_TOOL_NAME,
  type Todo,
  type TodoAssignee,
} from "./types";

// The version line starts each contribution. The host escapes the text, so
// other text cannot fake a contribution.
const VERSION_LINE = /^To-do version (\d+)\./;

/** Render an assignee as the text that `todos_updateTodos` accepts. */
export function renderTodoAssignee(assignee: TodoAssignee): string {
  switch (assignee.kind) {
    case "self":
      return SELF_TODO_ASSIGNEE;
    case "agent":
      return assignee.name ?? assignee.conversationId;
    case "user":
      return assignee.email;
  }
}

function renderAuthor(todo: Todo): string | undefined {
  if (todo.changedBy) {
    const { email, name } = todo.changedBy;
    return name ? `${name} (${email})` : email;
  }
  if (todo.changedByAgent) {
    return `child agent ${todo.changedByAgent.name ?? todo.changedByAgent.conversationId}`;
  }
  return undefined;
}

function renderTodo(todo: Todo, withAuthor: boolean): string {
  const author = withAuthor ? renderAuthor(todo) : undefined;
  const fields = [
    todo.status,
    `assignee ${renderTodoAssignee(todo.assignee)}`,
    ...(author ? [`changed by ${author}`] : []),
  ];
  const notes = todo.notes ? `\n  Notes: ${todo.notes}` : "";
  return `- ${todoRef(todo.id)} (${fields.join(", ")}): ${todo.title}${notes}`;
}

function todosVersion(todos: readonly Todo[]): number {
  return Math.max(...todos.map((todo) => todo.version));
}

// Highest To-do version in the To-do contributions of one message: a delta
// or a review in a Turn context, or a snapshot in a compaction summary.
function contributionsVersion(message: PromptHistoryMessage): number {
  if (message.type !== "context" && message.type !== "summary") return 0;
  let seen = 0;
  for (const text of message.contributions) {
    const version = VERSION_LINE.exec(text)?.[1];
    if (version) seen = Math.max(seen, Number(version));
  }
  return seen;
}

/** Return the highest To-do version that the history shows. */
export function latestSeenTodosVersion(
  messages: readonly PromptHistoryMessage[],
): number {
  let seen = 0;
  for (const message of messages) {
    seen = Math.max(seen, contributionsVersion(message));
  }
  return seen;
}

/**
 * Render the changes that people and child agents made after the version
 * that history shows, or null when there are none. Changes of the list's own
 * agent are left out: its tool calls and results are already in history.
 */
export function renderTodoDelta(
  todos: readonly Todo[],
  seenVersion: number,
): string | null {
  const changed = todos.filter(
    (todo) =>
      (todo.changedBy || todo.changedByAgent) && todo.version > seenVersion,
  );
  if (changed.length === 0) return null;
  return [
    `To-do version ${todosVersion(todos)}. Others changed these To-dos since you last saw them. Each To-do shows its current fields.`,
    ...changed.map((todo) => renderTodo(todo, true)),
  ].join("\n");
}

/**
 * Render every open To-do as one snapshot, or null when the Conversation has
 * no To-dos. When every To-do is closed, the block still keeps the version
 * in history.
 */
export function renderTodosSnapshot(todos: readonly Todo[]): string | null {
  if (todos.length === 0) return null;
  const open = todos.filter((todo) => isOpenTodoStatus(todo.status));
  return [
    `To-do version ${todosVersion(todos)}. ${
      open.length > 0 ? "Your open To-dos." : "You have no open To-dos."
    }`,
    ...open.map((todo) => renderTodo(todo, false)),
  ].join("\n");
}

// A review comes back after this many inputs, about one per Turn, with no
// To-do change and no To-do contribution. Each review is one, so it cannot
// repeat every Turn.
const TODOS_REVIEW_INTERVAL = 3;

// An input is a prompt or a steering message. A compaction summary without
// To-dos counts as one too.
function isInput(message: PromptHistoryMessage): boolean {
  return message.type === "input" || message.type === "summary";
}

function showsTodos(message: PromptHistoryMessage): boolean {
  if (message.type === "tool_result") {
    return !message.is_error && message.tool_name === UPDATE_TODOS_TOOL_NAME;
  }
  return contributionsVersion(message) > 0;
}

/**
 * Render every open To-do as a review, or null when there are no
 * open To-dos or history showed the To-dos recently. The model forgets to
 * close To-dos whose work ended, so stale To-dos come back on a fixed
 * interval.
 */
export function renderTodosReview(
  todos: readonly Todo[],
  messages: readonly PromptHistoryMessage[],
): string | null {
  const open = todos.filter((todo) => isOpenTodoStatus(todo.status));
  if (open.length === 0) return null;
  let inputs = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (showsTodos(message)) return null;
    if (isInput(message)) inputs += 1;
    if (inputs >= TODOS_REVIEW_INTERVAL) break;
  }
  if (inputs < TODOS_REVIEW_INTERVAL) return null;
  return [
    `To-do version ${todosVersion(todos)}. These To-dos are still open. Close each one whose work ended.`,
    ...open.map((todo) => renderTodo(todo, false)),
  ].join("\n");
}
