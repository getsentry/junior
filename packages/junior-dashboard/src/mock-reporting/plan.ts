import type {
  ConversationPlanItem,
  ConversationPlanReport,
  PlanItemStatusBody,
} from "@sentry/junior/api/schema";
import {
  DASHBOARD_QA_CONVERSATION_ID,
  DASHBOARD_QA_PLAN_ID,
  readMockConversationDetail,
} from "./fixtures";

const MINUTE_MS = 60_000;

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Process-local status changes, so mock QA can close and reopen items. */
const mockPlanStatuses = new Map<number, ConversationPlanItem["status"]>();

/** Clear mock plan changes so tests sharing a worker do not leak state. */
export function resetMockPlan(): void {
  mockPlanStatuses.clear();
}

function qaPlanItems(): ConversationPlanItem[] {
  const items: ConversationPlanItem[] = [
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
  ];
  return items.map((item) => ({
    ...item,
    status: mockPlanStatuses.get(item.id) ?? item.status,
  }));
}

/**
 * Return the Plan of one mock Conversation. The dashboard QA Conversation has
 * one item of each shape: its own agent, a child agent, a person, a private
 * item, and a closed item.
 */
export function readMockConversationPlan(
  conversationId: string,
): ConversationPlanReport | undefined {
  if (!readMockConversationDetail(conversationId)) return undefined;
  return {
    conversationId,
    items: conversationId === DASHBOARD_QA_CONVERSATION_ID ? qaPlanItems() : [],
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
  mockPlanStatuses.set(itemId, body.status);
  return { ...item, status: body.status, updatedAt: iso(0) };
}
