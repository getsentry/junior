import { describe, expect, it } from "vitest";
import { gitHubConflictAsks } from "../src/merge-conflict-checks/policy";

const fix = { atMs: 100, headSha: "1".repeat(40) };

describe("merge conflict asks from the item history", () => {
  it("holds the latest ask while it is open or a person dismissed it", () => {
    expect(gitHubConflictAsks([], [fix])).toEqual({ holds: false });
    expect(
      gitHubConflictAsks([{ id: "item-1", status: "open" }], [fix]),
    ).toEqual({ holds: true });
    expect(
      gitHubConflictAsks([{ id: "item-1", status: "dismissed" }], [fix]),
    ).toEqual({ holds: true });
    // Junior closed it when the conflict went, so a later fix that does not
    // land asks again.
    expect(
      gitHubConflictAsks([{ id: "item-1", status: "done" }], [fix]),
    ).toEqual({ holds: false });
  });

  it("counts the latest Resume that started a fix, also after a new ask", () => {
    const items = [
      { id: "item-3", status: "open" as const },
      {
        choice: "Resume",
        id: "item-2",
        status: "done" as const,
      },
      {
        choice: "Resume",
        id: "item-1",
        status: "done" as const,
      },
    ];
    expect(
      gitHubConflictAsks(items, [
        { ...fix, atMs: 200, itemId: "item-1" },
        // A retry of the answer ran the Resume after the item closed.
        { atMs: 350, headSha: "2".repeat(40), itemId: "item-2" },
        { atMs: 400, headSha: "3".repeat(40) },
      ]),
    ).toEqual({ holds: true, resume: { atMs: 350, itemId: "item-2" } });
  });

  it("does not count a Resume that started no fix", () => {
    const items = [
      {
        choice: "Resume",
        id: "item-2",
        status: "done" as const,
      },
      {
        choice: "Resume",
        id: "item-1",
        status: "done" as const,
      },
    ];
    // The Resume on item-2 started no fix, so item-1's Resume is the latest.
    expect(
      gitHubConflictAsks(items, [{ ...fix, atMs: 200, itemId: "item-1" }]),
    ).toEqual({ holds: false, resume: { atMs: 200, itemId: "item-1" } });
    expect(gitHubConflictAsks(items, [fix])).toEqual({ holds: false });
  });
});
