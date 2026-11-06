import { describe, expect, it } from "vitest";
import { sidebarThreads } from "../src/client/conversations/sidebarThreads";
import type { Conversation } from "../src/client/types";

function thread(
  id: string,
  lastSeenAt: string,
  threads?: Conversation[],
): Conversation {
  return {
    cumulativeDurationMs: 0,
    displayTitle: id,
    id,
    kind: "thread",
    lastProgressAt: lastSeenAt,
    lastSeenAt,
    startedAt: lastSeenAt,
    status: "completed",
    surface: "internal",
    ...(threads ? { threads } : undefined),
  };
}

const threads = [
  thread("a", "2026-01-05T00:00:00.000Z", [
    thread("a1", "2026-01-01T00:00:00.000Z"),
  ]),
  thread("b", "2026-01-04T00:00:00.000Z"),
  thread("c", "2026-01-06T00:00:00.000Z"),
  thread("d", "2026-01-02T00:00:00.000Z"),
];

function ids(result: ReturnType<typeof sidebarThreads>) {
  return result.threads.map((entry) => entry.conversation.id);
}

describe("sidebarThreads", () => {
  it("shows the three most recent Threads in tree order", () => {
    const result = sidebarThreads(threads, { expanded: false });
    expect(ids(result)).toEqual(["a", "b", "c"]);
    expect(result.hiddenCount).toBe(2);
  });

  it("keeps the open Thread and its depth", () => {
    const result = sidebarThreads(threads, {
      expanded: false,
      selectedId: "a1",
    });
    expect(result.threads).toContainEqual({
      conversation: threads[0]!.threads![0],
      depth: 1,
    });
    expect(ids(result)).toEqual(["a", "a1", "b", "c"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("shows every Thread when expanded", () => {
    const result = sidebarThreads(threads, { expanded: true });
    expect(ids(result)).toEqual(["a", "a1", "b", "c", "d"]);
    expect(result.hiddenCount).toBe(0);
  });
});
