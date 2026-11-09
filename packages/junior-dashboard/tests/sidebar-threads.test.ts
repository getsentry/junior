import { describe, expect, it } from "vitest";
import { sidebarThreads } from "../src/client/conversations/sidebarThreads";
import type { Conversation } from "../src/client/types";

/** Build a Thread whose last activity is `hour` hours into the day. */
function thread(
  id: string,
  hour: number,
  threads?: Conversation[],
): Conversation {
  const at = new Date(Date.UTC(2026, 0, 1, hour)).toISOString();
  return {
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    kind: "thread",
    lastProgressAt: at,
    lastSeenAt: at,
    startedAt: at,
    status: "idle",
    surface: "internal",
    ...(threads ? { threads } : undefined),
  };
}

function rows(result: ReturnType<typeof sidebarThreads>) {
  return result.threads.map((entry) => [entry.conversation.id, entry.depth]);
}

describe("sidebarThreads", () => {
  // a1 is recent, but only direct Threads count toward the cap.
  const threads = [
    thread("b", 10),
    thread("c", 8),
    thread("a", 2, [thread("a1", 9)]),
    thread("d", 1),
  ];

  it("caps direct Threads and keeps nested Threads under their parent", () => {
    const result = sidebarThreads(threads, { expanded: false });
    expect(rows(result)).toEqual([
      ["b", 0],
      ["c", 0],
      ["a", 0],
      ["a1", 1],
    ]);
    expect(result).toMatchObject({ collapsible: true, hiddenCount: 1 });
  });

  it("shows the chain to an open Thread past the cap", () => {
    const result = sidebarThreads(
      [
        thread("b", 10),
        thread("c", 8),
        thread("e", 6),
        thread("a", 1, [thread("a1", 2)]),
      ],
      { expanded: false, selectedId: "a1" },
    );
    expect(rows(result)).toEqual([
      ["b", 0],
      ["c", 0],
      ["e", 0],
      ["a", 0],
      ["a1", 1],
    ]);
    expect(result.hiddenCount).toBe(0);
  });

  it("shows every Thread when expanded", () => {
    const result = sidebarThreads(threads, { expanded: true });
    expect(rows(result)).toEqual([
      ["b", 0],
      ["c", 0],
      ["a", 0],
      ["a1", 1],
      ["d", 0],
    ]);
    expect(result.hiddenCount).toBe(0);
  });
});
