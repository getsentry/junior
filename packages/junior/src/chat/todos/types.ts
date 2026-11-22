/** Statuses of a To-do. `done` and `dropped` close it. */
export const TODO_STATUSES = [
  "open",
  "in_progress",
  "done",
  "dropped",
] as const;

/** One To-do status. */
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** Statuses that close a To-do. */
export type ClosedTodoStatus = Extract<TodoStatus, "done" | "dropped">;

/** Statuses of a To-do that is still work to do. */
export const OPEN_TODO_STATUSES = [
  "open",
  "in_progress",
] as const satisfies readonly TodoStatus[];

/** Whether a To-do with this status is still work to do. */
export function isOpenTodoStatus(status: TodoStatus): boolean {
  return status === "open" || status === "in_progress";
}

/** Model-facing tool that changes the To-dos. */
export const UPDATE_TODOS_TOOL_NAME = "updateTodos";

/** Assignee text for the list's own agent, in tool results and blocks. */
export const SELF_TODO_ASSIGNEE = "self";

/** Who works on a To-do. */
export type TodoAssignee =
  | { kind: "self" }
  | { kind: "agent"; conversationId: string; name?: string | undefined }
  | {
      kind: "user";
      userId: string;
      email: string;
      name?: string | undefined;
    };

/** One stored To-do, with its assignee resolved for display. */
export interface Todo {
  id: number;
  title: string;
  notes?: string | undefined;
  status: TodoStatus;
  assignee: TodoAssignee;
  /** To-do version of the latest change to the To-do. */
  version: number;
  /** The person who made the latest change. Unset when the list's agent did. */
  changedBy?:
    | { userId: string; email: string; name?: string | undefined }
    | undefined;
  /**
   * The assignee child agent that made the latest change: it closed the
   * To-do, or core closed it on the child's result.
   */
  changedByAgent?:
    | { conversationId: string; name?: string | undefined }
    | undefined;
  createdAtMs: number;
  updatedAtMs: number;
}
