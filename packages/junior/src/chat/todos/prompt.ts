/**
 * How the model sees its To-dos, Lore-style: the model's own `updateTodos`
 * calls are already in history, so they get no block. A Turn adds a
 * `<todo-delta>` only for changes that others made since the highest
 * version that history shows. Compaction folds it all into one `<todos>`
 * snapshot of the open To-dos. A Turn context also gets that `<todos>` when
 * history has not shown the To-dos for a few Turns, so stale To-dos get
 * closed. Both blocks start with that version as plain text, and later
 * deltas build on it.
 */
import type { PiMessage } from "@/chat/pi/messages";
import { isCompactionSummaryText } from "@/chat/services/context-compaction-marker";
import { TURN_CONTEXT_TAG } from "@/chat/turn-context-tag";
import {
  escapeTagText,
  findTags,
  renderTag,
  startsWithTag,
} from "@sentry/junior-plugin-api";
import { todoRef } from "./tool-output";
import {
  isToolResultError,
  isToolResultMessage,
  normalizeToolNameFromResult,
} from "@/chat/pi/transcript";
import {
  isOpenTodoStatus,
  SELF_TODO_ASSIGNEE,
  UPDATE_TODOS_TOOL_NAME,
  type Todo,
  type TodoAssignee,
} from "./types";

/**
 * Turn context section with the To-do changes that others made. Blocks are
 * append-only; context compaction replaces them with one `<todos>` snapshot.
 */
export const TODO_DELTA_TAG = "todo-delta";

/** Compacted context block with every open To-do. */
export const TODOS_TAG = "todos";

// The version line starts the body. Escaped person text cannot write a
// tag, so it cannot fake this line.
const VERSION_LINE = /^To-do version (\d+)\./;

/** Render an assignee as the text that `updateTodos` accepts. */
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
  return escapeTagText(
    `- ${todoRef(todo.id)} (${fields.join(", ")}): ${todo.title}${notes}`,
  );
}

function todosVersion(todos: readonly Todo[]): number {
  return Math.max(...todos.map((todo) => todo.version));
}

function textParts(message: PiMessage): string[] {
  if (!("role" in message) || message.role !== "user") return [];
  const { content } = message;
  if (typeof content === "string") return [content];
  return content.flatMap((part) => (part.type === "text" ? [part.text] : []));
}

// Highest To-do version in the runtime blocks of one message: a
// `<todo-delta>` in a Turn context or a `<todos>` in either a Turn context or
// a compaction summary. Text that people write is escaped, so it cannot fake
// one.
function todosBlockVersion(message: PiMessage): number {
  let seen = 0;
  for (const text of textParts(message)) {
    if (
      !startsWithTag(text, [TURN_CONTEXT_TAG]) &&
      !isCompactionSummaryText(text)
    ) {
      continue;
    }
    for (const tag of [TODOS_TAG, TODO_DELTA_TAG]) {
      for (const block of findTags(text, tag)) {
        const version = VERSION_LINE.exec(block.body)?.[1];
        if (version) seen = Math.max(seen, Number(version));
      }
    }
  }
  return seen;
}

/** Return the highest To-do version that the runtime blocks of history show. */
export function latestSeenTodosVersion(messages: readonly PiMessage[]): number {
  let seen = 0;
  for (const message of messages) {
    seen = Math.max(seen, todosBlockVersion(message));
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
  return renderTag(TODO_DELTA_TAG, {}, [
    `To-do version ${todosVersion(todos)}. Others changed these To-dos since you last saw them. Each To-do shows its current fields.`,
    ...changed.map((todo) => renderTodo(todo, true)),
  ]);
}

/**
 * Render every open To-do as one snapshot, or null when the Conversation has
 * no To-dos. When every To-do is closed, the block still keeps the version
 * in history.
 */
export function renderTodosSnapshot(todos: readonly Todo[]): string | null {
  if (todos.length === 0) return null;
  const open = todos.filter((todo) => isOpenTodoStatus(todo.status));
  return renderTag(TODOS_TAG, {}, [
    `To-do version ${todosVersion(todos)}. ${
      open.length > 0 ? "Your open To-dos." : "You have no open To-dos."
    }`,
    ...open.map((todo) => renderTodo(todo, false)),
  ]);
}

// A review comes back after this many inputs, about one per Turn, with no
// To-do change and no To-do block. Each review is a To-do block, so it cannot
// repeat every Turn.
const TODOS_REVIEW_INTERVAL = 3;

// An input is a user message other than a Turn context, such as a prompt or
// a steering message. A Turn context is its own message before the prompt.
function isInput(message: PiMessage): boolean {
  const texts = textParts(message);
  return (
    texts.length > 0 &&
    !texts.some((text) => startsWithTag(text, [TURN_CONTEXT_TAG]))
  );
}

function showsTodos(message: PiMessage): boolean {
  if (isToolResultMessage(message)) {
    return (
      !isToolResultError(message) &&
      normalizeToolNameFromResult(message) === UPDATE_TODOS_TOOL_NAME
    );
  }
  return todosBlockVersion(message) > 0;
}

/**
 * Render every open To-do as a `<todos>` review, or null when there are no
 * open To-dos or history showed the To-dos recently. The model forgets to
 * close To-dos whose work ended, so stale To-dos come back on a fixed
 * interval.
 */
export function renderTodosReview(
  todos: readonly Todo[],
  messages: readonly PiMessage[],
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
  return renderTag(TODOS_TAG, {}, [
    `To-do version ${todosVersion(todos)}. These To-dos are still open. Close each one whose work ended.`,
    ...open.map((todo) => renderTodo(todo, false)),
  ]);
}
