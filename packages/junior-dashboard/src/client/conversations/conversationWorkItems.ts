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
      /** The Watches of `child`, which show on this row. */
      childWatches: ConversationWatch[];
    }
  | {
      kind: "child";
      key: string;
      state: WorkState;
      child: ConversationChildAgent;
      /** The Watches that the child owns, which show on this row. */
      childWatches: ConversationWatch[];
    }
  | { kind: "watch"; key: string; state: WorkState; watch: ConversationWatch };

/**
 * Read where a child Conversation stands. A wait on the viewer comes first,
 * then a run that is going, then how an earlier Turn ended. An archived
 * child is done.
 */
export function childWorkState(child: ConversationChildAgent): WorkState {
  if (child.archivedAt) return "done";
  const { lastResult, status: agentStatus, treeState } = child;
  if (treeState === "needs_you") return "blocked";
  if (agentStatus === "running" || agentStatus === "pending") return "running";
  if (agentStatus === "failed") return "failed";
  if (agentStatus === "idle" && lastResult === "failed") return "failed";
  if (agentStatus === "idle" && lastResult === "blocked") return "blocked";
  // A nested child can still work after this child's own run ended.
  if (treeState === "working") return "running";
  if (agentStatus === "paused" || child.watching) return "waiting";
  return "done";
}

function todoWorkState(
  todo: ConversationTodo,
  child: ConversationChildAgent | undefined,
): WorkState {
  // A child that still works shows, even when its To-do is closed. A child
  // that finished leaves its open To-do open, not finished.
  const childState = child ? childWorkState(child) : "done";
  if (childState !== "done") return childState;
  if (todo.status === "done" || todo.status === "dropped") return "done";
  return todo.status === "in_progress" ? "running" : "todo";
}

/**
 * Join the To-dos, child Conversations, and Watches of one Conversation
 * into one list, sorted by `WORK_STATES`, each kind in its loaded order. A
 * To-do assigned to a listed child is one row with the child's state while
 * the child has work going, and the To-do's own state after that. A
 * Watch that a listed child owns shows on that child's row. The
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
  const watchesByChild = new Map<string, ConversationWatch[]>();
  // A Watch whose child is not listed, such as a grandchild's, keeps its own
  // row, so it can still be cancelled.
  const ownWatches: ConversationWatch[] = [];
  for (const watch of input.watches) {
    const owner = watch.childAgent?.conversationId;
    if (owner && childById.has(owner)) {
      watchesByChild.set(owner, [...(watchesByChild.get(owner) ?? []), watch]);
    } else {
      ownWatches.push(watch);
    }
  }
  const childWatches = (child: ConversationChildAgent | undefined) =>
    (child && watchesByChild.get(child.conversationId)) ?? [];
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
      childWatches: childWatches(child),
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
      childWatches: childWatches(child),
      key: `child:${child.conversationId}`,
      kind: "child",
      state: childWorkState(child),
    });
  }
  for (const watch of ownWatches) {
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
