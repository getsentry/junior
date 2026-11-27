import { describe, expect, it } from "vitest";
import { gitHubConflictAsks } from "../src/merge-conflict-checks/policy";

const fix = { atMs: 100, headSha: "1".repeat(40) };
const minute = 60_000;
const nowMs = 60 * minute;

describe("merge conflict asks from the item history", () => {
  it("holds the latest ask while it is open or a person dismissed it", () => {
    const asks = (status: "open" | "done" | "dismissed") =>
      gitHubConflictAsks(
        [{ closedAtMs: 0, id: "item-1", status }],
        [fix],
        nowMs,
      ).holds;
    expect(gitHubConflictAsks([], [fix], nowMs)).toEqual({
      holds: false,
      resuming: false,
    });
    expect(asks("open")).toBe(true);
    expect(asks("dismissed")).toBe(true);
    // Junior closed it when the conflict went, so a later fix that does not
    // land asks again.
    expect(asks("done")).toBe(false);
  });

  it("counts the latest Resume that started a fix, also after a new ask", () => {
    const items = [
      { id: "item-3", status: "open" as const },
      {
        action: "resume",
        closedAtMs: 300,
        id: "item-2",
        status: "done" as const,
      },
      {
        action: "resume",
        closedAtMs: 200,
        id: "item-1",
        status: "done" as const,
      },
    ];
    expect(
      gitHubConflictAsks(
        items,
        [
          { ...fix, atMs: 200, itemId: "item-1" },
          // A retry of the action ran the Resume after the item closed.
          { atMs: 350, headSha: "2".repeat(40), itemId: "item-2" },
          { atMs: 400, headSha: "3".repeat(40) },
        ],
        nowMs,
      ),
    ).toEqual({
      holds: true,
      resume: { atMs: 350, itemId: "item-2" },
      resuming: false,
    });
  });

  it("waits on a Resume that has saved no fix, then lets the next conflict ask", () => {
    const items = [
      {
        action: "resume",
        closedAtMs: nowMs - minute,
        id: "item-2",
        status: "done" as const,
      },
      {
        action: "resume",
        closedAtMs: 200,
        id: "item-1",
        status: "done" as const,
      },
    ];
    const fixes = [{ ...fix, atMs: 200, itemId: "item-1" }];
    // Core closed item-2 a minute ago, and its Resume is still starting.
    expect(gitHubConflictAsks(items, fixes, nowMs)).toEqual({
      holds: false,
      resume: { atMs: 200, itemId: "item-1" },
      resuming: true,
    });
    // Minutes later, the Resume on item-2 started no fix.
    expect(gitHubConflictAsks(items, fixes, nowMs + 10 * minute)).toEqual({
      holds: false,
      resume: { atMs: 200, itemId: "item-1" },
      resuming: false,
    });
    // Once its fix is saved, the Resume on item-2 is the latest.
    expect(
      gitHubConflictAsks(
        items,
        [...fixes, { atMs: nowMs, headSha: "2".repeat(40), itemId: "item-2" }],
        nowMs,
      ),
    ).toEqual({
      holds: false,
      resume: { atMs: nowMs, itemId: "item-2" },
      resuming: false,
    });
  });
});
