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

  it("lists every Thread in attention order, with no group headings", () => {
    const markup = render(threads);
    expect(markup).toContain(">Threads<");
    const found = positions(markup, [
      "Approve the cutover window",
      "Reconcile Stripe balances",
      "Close the books",
    ]);
    expect(found.every((at) => at >= 0)).toBe(true);
    expect(found).toEqual([...found].sort((left, right) => left - right));
    // The list shows its first rows, and the rest wait behind Show more.
    expect(markup).toContain("Show 3 more");
    expect(markup).not.toContain("Check refund webhooks");
    expect(markup).not.toMatch(/Needs you ·|Working ·|Waiting ·|Done ·/);
  });

  it("shows each row's state and a Thread link", () => {
    const first = render(threads);
    // A finished Thread shows how its last Turn ended.
    expect(first).toContain('<span class="sr-only">failed</span>');
    // A wait on the viewer, work in its tree, or a Watch shows over the
    // run's own status.
    expect(first).toContain('aria-label="Waiting on you"');
    expect(first).toContain('aria-label="Working"');
    const rest = render(threads.slice(0, 3));
    expect(rest).toContain('aria-label="Watching for an event"');
    expect(rest).toContain(
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

  it("names a Space's failed child a Thread", () => {
    expect(renderToStaticMarkup(<SpaceStateIcon state="failed" />)).toContain(
      'aria-label="A Thread failed"',
    );
  });
});
