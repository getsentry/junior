import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { SpaceStateIcon } from "../src/client/spaces/SpaceStateIcon";
import { SpaceThreads, ThreadGroups } from "../src/client/spaces/SpaceThreads";
import type { Conversation } from "../src/client/types";

function thread(
  title: string,
  hour: number,
  fields: Partial<Conversation> = {},
): Conversation {
  const at = `2026-08-03T${String(hour).padStart(2, "0")}:00:00.000Z`;
  return {
    cumulativeDurationMs: 0,
    displayTitle: title,
    id: `internal:${title.toLowerCase().replaceAll(" ", "-")}`,
    isParticipant: true,
    kind: "thread",
    lastMessageAt: at,
    lastProgressAt: at,
    lastSeenAt: at,
    startedAt: at,
    status: "done",
    surface: "internal",
    treeState: "done",
    turnActive: false,
    ...fields,
  };
}

function render(threads: Conversation[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadGroups threads={threads} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Where each label first shows in the markup, or -1. */
function positions(markup: string, labels: string[]): number[] {
  return labels.map((label) => markup.indexOf(label));
}

describe("a Space's Threads", () => {
  const threads = [
    thread("Map plan IDs", 1),
    thread("Check refund webhooks", 5, {
      treeState: "working",
      turnActive: true,
    }),
    thread("Backfill invoice IDs", 4, { watching: true }),
    thread("Approve the cutover window", 3, { treeState: "needs_you" }),
    thread("Reconcile Stripe balances", 2, {
      latestTurnFailed: true,
      summary: "Lost access to the API.",
    }),
  ];

  it("labels each group with its count, needs you first", () => {
    const found = positions(render(threads), [
      "Needs you · 2",
      "Working · 1",
      "Waiting · 1",
      "Done · 1",
    ]);
    expect(found.every((at) => at >= 0)).toBe(true);
    expect(found).toEqual([...found].sort((left, right) => left - right));
  });

  it("lists rows newest first, each with its summary and a Thread link", () => {
    const markup = render(threads);
    expect(markup.indexOf("Approve the cutover window")).toBeLessThan(
      markup.indexOf("Reconcile Stripe balances"),
    );
    expect(markup).toContain("Lost access to the API.");
    expect(markup).toContain('aria-label="Failed"');
    expect(markup).toContain(
      'href="/conversations/internal%3Acheck-refund-webhooks"',
    );
  });

  it("starts Done collapsed", () => {
    const markup = render(threads);
    expect(markup).toMatch(/<button[^>]*aria-expanded="false"[^>]*>Done · 1/);
    expect(markup).not.toContain("Map plan IDs");
  });
});

describe("Space copy", () => {
  it("names a Space's child Conversations Threads", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ["dashboard", "conversations", "space", { spaceId: "space-1" }],
      { conversations: [] },
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SpaceThreads spaceId="space-1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(markup).toContain('aria-label="Threads"');
    expect(markup).toContain(">Threads<");
    expect(markup).toContain("No Threads in this Space yet.");
    expect(renderToStaticMarkup(<SpaceStateIcon state="failed" />)).toContain(
      'aria-label="A Thread failed"',
    );
  });
});
