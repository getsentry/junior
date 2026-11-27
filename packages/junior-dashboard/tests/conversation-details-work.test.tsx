import type {
  ConversationChildAgent,
  ConversationDetailReport,
} from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import {
  childState,
  childUpdateReasons,
} from "../src/client/conversations/ConversationAgents";

function thread(
  title: string,
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
    updatedAt: "2026-08-03T00:00:00.000Z",
    watching: false,
    ...fields,
  };
}

type ReportEvent = ConversationDetailReport["events"][number];

function update(
  seq: number,
  fields: Partial<Extract<ReportEvent["data"], { type: "message" }>>,
): ReportEvent {
  return {
    createdAt: "2026-08-03T00:00:00.000Z",
    data: {
      eventType: "agent.update",
      messageId: `m${seq}`,
      role: "user",
      type: "message",
      ...fields,
    },
    seq,
  };
}

describe("a child Conversation's state", () => {
  it("comes from the child's own run", () => {
    const states = [
      thread("Map plan IDs"),
      thread("Check refund webhooks", { status: "running" }),
      thread("Backfill invoice IDs", { watching: true }),
      thread("Wait for approval", { status: "paused" }),
      // Its own run ended, but a nested child still works.
      thread("Close the books", { treeState: "working" }),
      thread("Reconcile Stripe balances", { lastResult: "failed" }),
      thread("Ask about the cutover", { lastResult: "blocked" }),
      thread("Stopped by a person", {
        lastResult: undefined,
        status: "stopped",
      }),
      thread("Old archived work", {
        archivedAt: "2026-08-03T07:00:00.000Z",
        status: "running",
      }),
    ].map((child) => childState(child));
    expect(states).toEqual([
      "done",
      "running",
      "watching",
      "paused",
      "running",
      "failed",
      "blocked",
      "stopped",
      "done",
    ]);
  });

  it("shows a failed Thread that waits on the viewer as waiting on you", () => {
    expect(
      childState(
        thread("Retry the export", {
          lastResult: "failed",
          treeState: "needs_you",
        }),
      ),
    ).toBe("needs_you");
  });

  it("reads why a child is blocked from its latest blocked update", () => {
    const reasons = childUpdateReasons([
      update(1, {
        eventIdentifier: "internal:a",
        eventStatus: "blocked",
        text: "Needs repo access.",
      }),
      // A progress update is not a reason.
      update(2, { eventIdentifier: "internal:a", text: "Still working." }),
      // A Watch delivered this update, so it says nothing about the child.
      update(3, {
        eventIdentifier: "internal:b",
        eventStatus: "failed",
        eventWatchId: "w1",
        text: "The deploy finished.",
      }),
      update(4, { eventType: "pull_request.merged", text: "Merged." }),
    ]);
    expect([...reasons]).toEqual([["internal:a", "Needs repo access."]]);
  });
});
