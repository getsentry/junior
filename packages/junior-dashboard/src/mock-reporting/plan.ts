import type {
  ConversationPlanItem,
  ConversationPlanReport,
  PlanItemStatusBody,
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

/** Process-local status changes, so mock QA can close and reopen items. */
const mockPlanStatuses = new Map<string, ConversationPlanItem["status"]>();

/** Clear mock plan changes so tests sharing a worker do not leak state. */
export function resetMockPlan(): void {
  mockPlanStatuses.clear();
}

// The dashboard QA Conversation has one item of each shape: its own agent, a
// child agent, a person, a private item, and a closed item. The viewer takes
// part in the active one, so its rows show the status menu.
const MOCK_PLANS: Record<string, () => ConversationPlanItem[]> = {
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
      status: "blocked",
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
      status: "blocked",
      assignee: { kind: "user", name: "Morgan Lee" },
      updatedAt: iso(-25 * MINUTE_MS),
    },
    {
      id: 44,
      status: "pending",
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
  ],
};

/** Return the Plan of one mock Conversation. */
export function readMockConversationPlan(
  conversationId: string,
): ConversationPlanReport | undefined {
  if (!readMockConversationDetail(conversationId)) return undefined;
  const items = MOCK_PLANS[conversationId]?.() ?? [];
  return {
    conversationId,
    items: items.map((item) => ({
      ...item,
      status:
        mockPlanStatuses.get(`${conversationId}:${item.id}`) ?? item.status,
    })),
  };
}

/** Set the status of one mock Plan item, like the API. */
export function setMockPlanItemStatus(
  conversationId: string,
  itemId: number,
  body: PlanItemStatusBody,
): ConversationPlanItem | undefined {
  const item = readMockConversationPlan(conversationId)?.items.find(
    (candidate) => candidate.id === itemId,
  );
  if (!item) return undefined;
  mockPlanStatuses.set(`${conversationId}:${itemId}`, body.status);
  return { ...item, status: body.status, updatedAt: iso(0) };
}
