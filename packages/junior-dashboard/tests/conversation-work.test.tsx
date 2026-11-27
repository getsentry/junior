import type { ConversationChildAgent } from "@sentry/junior/api/schema";
import type {
  ConversationTodo,
  ConversationWatch,
} from "@sentry/junior/api/schema";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { conversationWorkItems } from "../src/client/conversations/conversationWorkItems";
import { SpaceStateIcon } from "../src/client/spaces/SpaceStateIcon";

function thread(
  title: string,
  hour: number,
  fields: Partial<ConversationChildAgent> = {},
): ConversationChildAgent {
  return {
    archivedAt: null,
    conversationId: `internal:${title.toLowerCase().replaceAll(" ", "-")}`,
    cumulativeDurationMs: 0,
    kind: "thread",
    lastResult: "done",
    status: "idle",
    title,
    treeState: "done",
    updatedAt: `2026-08-03T${String(hour).padStart(2, "0")}:00:00.000Z`,
    watching: false,
    ...fields,
  };
}

function todo(
  id: number,
  fields: Partial<ConversationTodo> = {},
): ConversationTodo {
  return {
    assignee: { kind: "self" },
    id,
    status: "open",
    title: `To-do ${id}`,
    updatedAt: "2026-08-03T00:00:00.000Z",
    ...fields,
  };
}

function watch(
  id: string,
  fields: Partial<ConversationWatch> = {},
): ConversationWatch {
  return {
    createdAt: "2026-08-03T00:00:00.000Z",
    events: ["pull_request.merged"],
    expiresAt: "2026-08-10T00:00:00.000Z",
    id,
    intent: `Watch ${id}`,
    label: `Watch ${id}`,
    namespace: "github",
    resourceType: "pull_request",
    ...fields,
  };
}

function keys(input: Parameters<typeof conversationWorkItems>[0]): string[] {
  return conversationWorkItems(input).map(
    (item) => `${item.state} ${item.key}`,
  );
}

describe("a Conversation's Work", () => {
  it("sorts blocked and failed, running, waiting, to do, then done", () => {
    expect(
      keys({
        children: [
          thread("Map plan IDs", 1),
          thread("Check refund webhooks", 5, {
            status: "running",
            treeState: "working",
          }),
          thread("Backfill invoice IDs", 4, { watching: true }),
          // Its own run ended, but a nested child still works.
          thread("Close the books", 6, { treeState: "working" }),
          thread("Reconcile Stripe balances", 2, { lastResult: "failed" }),
          thread("Ask about the cutover", 3, { lastResult: "blocked" }),
          thread("Old archived work", 0, {
            archivedAt: "2026-08-03T07:00:00.000Z",
            status: "running",
          }),
        ],
        todos: [todo(1), todo(2, { status: "done" })],
        viewerTodoIds: new Set(),
        watches: [watch("w1")],
      }),
    ).toEqual([
      "failed child:internal:reconcile-stripe-balances",
      "blocked child:internal:ask-about-the-cutover",
      "running child:internal:check-refund-webhooks",
      "running child:internal:close-the-books",
      "waiting child:internal:backfill-invoice-ids",
      "waiting watch:w1",
      "todo todo:1",
      "done todo:2",
      "done child:internal:map-plan-ids",
      "done child:internal:old-archived-work",
    ]);
  });

  it("shows a To-do assigned to a child as one row with the child's state", () => {
    const child = thread("Fix the flaky test", 1, { status: "running" });
    expect(
      keys({
        children: [child],
        todos: [
          todo(1, {
            assignee: { conversationId: child.conversationId, kind: "agent" },
          }),
        ],
        viewerTodoIds: new Set(),
        watches: [],
      }),
    ).toEqual(["running todo:1"]);
    // An open To-do stays open after its child finishes.
    expect(
      keys({
        children: [{ ...child, status: "idle" }],
        todos: [
          todo(1, {
            assignee: { conversationId: child.conversationId, kind: "agent" },
          }),
        ],
        viewerTodoIds: new Set(),
        watches: [],
      }),
    ).toEqual(["todo todo:1"]);
  });

  it("leaves out child Watches and the viewer's own open To-dos", () => {
    expect(
      keys({
        children: [],
        todos: [todo(1), todo(2), todo(3, { status: "done" })],
        // Needs you shows open To-dos 1 and 3; a closed one stays in Work.
        viewerTodoIds: new Set([1, 3]),
        watches: [
          watch("w1", { childAgent: { conversationId: "internal:child" } }),
          watch("w2"),
        ],
      }),
    ).toEqual(["waiting watch:w2", "todo todo:2", "done todo:3"]);
  });

  it("names a Space's failed child a Thread", () => {
    expect(renderToStaticMarkup(<SpaceStateIcon state="failed" />)).toContain(
      'aria-label="A Thread failed"',
    );
  });
});
