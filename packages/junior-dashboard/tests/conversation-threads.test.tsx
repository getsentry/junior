import type { ConversationChildAgent } from "@sentry/junior/api/schema";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { ConversationThreads } from "../src/client/conversations/ConversationChildAgents";
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

function render(threads: ConversationChildAgent[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ConversationThreads threads={threads} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Where each label first shows in the markup, or -1. */
function positions(markup: string, labels: string[]): number[] {
  return labels.map((label) => markup.indexOf(label));
}

describe("a Conversation's Threads", () => {
  const threads = [
    thread("Map plan IDs", 1),
    thread("Check refund webhooks", 5, {
      status: "running",
      treeState: "working",
    }),
    thread("Backfill invoice IDs", 4, { watching: true }),
    // Its own run ended, but a nested child still works.
    thread("Close the books", 6, { treeState: "working" }),
    thread("Approve the cutover window", 3, { treeState: "needs_you" }),
    thread("Reconcile Stripe balances", 2, { lastResult: "failed" }),
  ];

  it("labels each group with its count, needs you first", () => {
    const markup = render(threads);
    expect(markup).toContain(">Threads<");
    const found = positions(markup, [
      "Needs you · 2",
      "Working · 2",
      "Waiting · 1",
      "Done · 1",
    ]);
    expect(found.every((at) => at >= 0)).toBe(true);
    expect(found).toEqual([...found].sort((left, right) => left - right));
  });

  it("lists rows newest first, each with its state and a Thread link", () => {
    const markup = render(threads);
    expect(markup.indexOf("Approve the cutover window")).toBeLessThan(
      markup.indexOf("Reconcile Stripe balances"),
    );
    // A finished Thread shows how its last Turn ended.
    expect(markup).toContain('<span class="sr-only">failed</span>');
    // A wait on the viewer, work in its tree, or a Watch shows over the
    // run's own status.
    expect(markup).toContain('aria-label="Waiting on you"');
    expect(markup).toContain('aria-label="Watching for an event"');
    expect(markup).toContain('aria-label="Working"');
    expect(markup).toContain(
      'href="/conversations/internal%3Acheck-refund-webhooks"',
    );
  });

  it("marks a failed Thread that waits on the viewer as waiting on you", () => {
    const markup = render([
      thread("Retry the export", 1, {
        lastResult: "failed",
        treeState: "needs_you",
      }),
    ]);
    expect(markup).toContain('aria-label="Waiting on you"');
  });

  it("starts Done collapsed", () => {
    const markup = render(threads);
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Done · 1/);
    expect(markup).not.toContain("Map plan IDs");
  });

  it("names a Space's failed child a Thread", () => {
    expect(renderToStaticMarkup(<SpaceStateIcon state="failed" />)).toContain(
      'aria-label="A Thread failed"',
    );
  });
});
