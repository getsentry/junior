import type {
  ConversationChildAgent,
  ConversationTodo,
  ConversationWatch,
} from "@sentry/junior/api/schema";

/** Where one piece of work stands, in the order that Work lists it. */
export const WORK_STATES = [
  "blocked",
  "failed",
  "running",
  "waiting",
  "todo",
  "done",
] as const;

export type WorkState = (typeof WORK_STATES)[number];

/** One row of Work: a To-do, a child Conversation, or a Watch or Timer. */
export type WorkItem =
  | {
      kind: "todo";
      key: string;
      state: WorkState;
      todo: ConversationTodo;
      /** The child agent that the To-do is assigned to, when listed. */
      child?: ConversationChildAgent | undefined;
    }
  | {
      kind: "child";
      key: string;
      state: WorkState;
      child: ConversationChildAgent;
    }
  | { kind: "watch"; key: string; state: WorkState; watch: ConversationWatch };

/**
 * Read where a child Conversation stands. A run that is going outranks how
 * an earlier Turn ended, and an archived child is done.
 */
export function childWorkState(child: ConversationChildAgent): WorkState {
  if (child.archivedAt) return "done";
  const { lastResult, status: agentStatus, treeState } = child;
  if (agentStatus === "running" || agentStatus === "pending") return "running";
  if (agentStatus === "failed") return "failed";
  if (agentStatus === "idle" && lastResult === "failed") return "failed";
  if (agentStatus === "idle" && lastResult === "blocked") return "blocked";
  // A nested child can still work after this child's own run ended.
  if (treeState === "working") return "running";
  if (treeState === "needs_you" || agentStatus === "paused" || child.watching) {
    return "waiting";
  }
  return "done";
}

function todoWorkState(
  todo: ConversationTodo,
  child: ConversationChildAgent | undefined,
): WorkState {
  if (todo.status === "done" || todo.status === "dropped") return "done";
  // A child that finished leaves its open To-do open, not finished.
  const state = child ? childWorkState(child) : "done";
  if (state !== "done") return state;
  return todo.status === "in_progress" ? "running" : "todo";
}

/**
 * Join the To-dos, child Conversations, and Watches of one Conversation
 * into one list, sorted by `WORK_STATES`, each kind in its loaded order. A
 * To-do assigned to a listed child is one row with the child's state while
 * the child has work going, and the To-do's own state after that. A
 * Watch that a child owns shows in that child's state, not as a row. The
 * viewer's own open To-dos (`viewerTodoIds`) show in Needs you instead.
 */
export function conversationWorkItems(input: {
  children: readonly ConversationChildAgent[];
  todos: readonly ConversationTodo[];
  viewerTodoIds: ReadonlySet<number>;
  watches: readonly ConversationWatch[];
}): WorkItem[] {
  const childById = new Map(
    input.children.map((child) => [child.conversationId, child]),
  );
  const childrenWithTodo = new Set<string>();
  const items: WorkItem[] = [];
  for (const todo of input.todos) {
    const open = todo.status === "open" || todo.status === "in_progress";
    if (open && input.viewerTodoIds.has(todo.id)) continue;
    const child =
      todo.assignee.kind === "agent"
        ? childById.get(todo.assignee.conversationId)
        : undefined;
    if (child) childrenWithTodo.add(child.conversationId);
    items.push({
      child,
      key: `todo:${todo.id}`,
      kind: "todo",
      state: todoWorkState(todo, child),
      todo,
    });
  }
  for (const child of input.children) {
    if (childrenWithTodo.has(child.conversationId)) continue;
    items.push({
      child,
      key: `child:${child.conversationId}`,
      kind: "child",
      state: childWorkState(child),
    });
  }
  for (const watch of input.watches) {
    if (watch.childAgent) continue;
    items.push({
      key: `watch:${watch.id}`,
      kind: "watch",
      state: "waiting",
      watch,
    });
  }
  const rank = (state: WorkState) =>
    // Blocked and failed share the first place.
    state === "failed" ? 0 : WORK_STATES.indexOf(state);
  // `sort` is stable, so each state keeps the loaded order.
  return items.sort((left, right) => rank(left.state) - rank(right.state));
}
