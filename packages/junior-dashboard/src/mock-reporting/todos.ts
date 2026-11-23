import type {
  ConversationTodo,
  ConversationTodosReport,
  SearchTodo,
  TodoStatusBody,
} from "@sentry/junior/api/schema";
import {
  ACTIVE_CONVERSATION_ID,
  DASHBOARD_QA_CONVERSATION_ID,
  DASHBOARD_QA_PLAN_ID,
  readMockConversationDetail,
} from "./fixtures";

const MINUTE_MS = 60_000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Process-local status changes, so mock QA can close and reopen To-dos. */
const mockTodoStatuses = new Map<string, ConversationTodo["status"]>();

/** Clear mock To-do changes so tests sharing a worker do not leak state. */
export function resetMockTodos(): void {
  mockTodoStatuses.clear();
}

// The dashboard QA Conversation has one To-do of each shape: its own agent, a
// child agent, a person, a private To-do, and each status. The viewer takes
// part in the active one, so its rows show the status menu.
const MOCK_TODOS: Record<string, () => ConversationTodo[]> = {
  [ACTIVE_CONVERSATION_ID]: () => [
    {
      id: 11,
      title: "Find the slow checkout span",
      status: "in_progress",
      assignee: { kind: "self" },
      updatedAt: iso(-3 * MINUTE_MS),
    },
    {
      id: 12,
      title: "Compare p95 with last week",
      notes: "Use the same region filter as the alert.",
      status: "in_progress",
      assignee: {
        kind: "agent",
        conversationId: "junior:local:checkout-latency:latency-sleuth",
        name: "latency-sleuth",
      },
      updatedAt: iso(-5 * MINUTE_MS),
    },
    {
      id: 13,
      title: "Confirm the rollback window",
      status: "open",
      assignee: { kind: "user", name: "Morgan Lee" },
      updatedAt: iso(-6 * MINUTE_MS),
    },
    {
      id: 10,
      title: "Pull the checkout traces",
      status: "done",
      assignee: { kind: "self" },
      updatedAt: iso(-9 * MINUTE_MS),
    },
  ],
  [DASHBOARD_QA_CONVERSATION_ID]: () => [
    {
      id: 41,
      title: "Fix the failing dashboard checks",
      status: "in_progress",
      assignee: { kind: "self" },
      updatedAt: iso(-12 * MINUTE_MS),
    },
    {
      id: 42,
      title: "Review the dashboard plan before editing",
      notes: "Check the empty states and the dark theme too.",
      status: "in_progress",
      assignee: {
        kind: "agent",
        conversationId: DASHBOARD_QA_PLAN_ID,
        name: "planner",
      },
      updatedAt: iso(-20 * MINUTE_MS),
    },
    {
      id: 43,
      title: "Approve the preview deploy",
      status: "open",
      assignee: { kind: "user", name: "Morgan Lee" },
      updatedAt: iso(-25 * MINUTE_MS),
    },
    {
      id: 44,
      status: "open",
      assignee: { kind: "self" },
      redacted: true,
      updatedAt: iso(-30 * MINUTE_MS),
    },
    {
      id: 40,
      title: "Read the review feedback",
      status: "done",
      assignee: { kind: "self" },
      changedBy: "Morgan Lee",
      updatedAt: iso(-40 * MINUTE_MS),
    },
    {
      id: 39,
      title: "Port the old dashboard theme",
      status: "dropped",
      assignee: { kind: "self" },
      updatedAt: iso(-45 * MINUTE_MS),
    },
  ],
};

/** Return the To-dos of one mock Conversation. */
export function readMockConversationTodos(
  conversationId: string,
): ConversationTodosReport | undefined {
  if (!readMockConversationDetail(conversationId)) return undefined;
  const todos = MOCK_TODOS[conversationId]?.() ?? [];
  return {
    conversationId,
    todos: todos.map((todo) => ({
      ...todo,
      status:
        mockTodoStatuses.get(`${conversationId}:${todo.id}`) ?? todo.status,
    })),
  };
}

/**
 * The mock To-dos that `/api/search` can find: every one whose title the
 * viewer sees, so never a redacted one.
 */
export function readMockSearchTodos(): SearchTodo[] {
  return Object.keys(MOCK_TODOS).flatMap((conversationId) =>
    (readMockConversationTodos(conversationId)?.todos ?? []).flatMap(
      ({ id, status, title }) =>
        title === undefined ? [] : [{ conversationId, id, status, title }],
    ),
  );
}

/** Set the status of one mock To-do, like the API. */
export function setMockTodoStatus(
  conversationId: string,
  todoId: number,
  body: TodoStatusBody,
): ConversationTodo | undefined {
  const todo = readMockConversationTodos(conversationId)?.todos.find(
    (candidate) => candidate.id === todoId,
  );
  if (!todo) return undefined;
  mockTodoStatuses.set(`${conversationId}:${todoId}`, body.status);
  return { ...todo, status: body.status, updatedAt: iso(0) };
}
