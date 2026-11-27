import { describe, expect, it } from "vitest";
import {
  spaceIndicatorState,
  statusIndicatorState,
} from "../src/client/conversations/StatusIndicator";

const ARCHIVED = "2026-08-07T10:00:00.000Z";

describe("statusIndicatorState", () => {
  it("orders a wait on the viewer or a failed Turn, then work, then done", () => {
    expect(
      statusIndicatorState({ treeState: "needs_you", turnActive: true }),
    ).toBe("needs_you");
    expect(
      statusIndicatorState({ latestTurnFailed: true, treeState: "working" }),
    ).toBe("needs_you");
    expect(
      statusIndicatorState({ treeState: "done", waitsOnViewer: true }),
    ).toBe("needs_you");
    expect(statusIndicatorState({ treeState: "working" })).toBe("working");
    expect(statusIndicatorState({ turnActive: true })).toBe("working");
    expect(statusIndicatorState({ treeState: "done" })).toBe("done");
    expect(statusIndicatorState({})).toBe("done");
  });

  it("shows nothing for an archived row", () => {
    expect(
      statusIndicatorState({ archivedAt: ARCHIVED, treeState: "needs_you" }),
    ).toBeUndefined();
  });

  it("shows nothing for a Space whose Threads need nothing", () => {
    expect(spaceIndicatorState({ treeState: "done" })).toBeUndefined();
    expect(spaceIndicatorState({ latestTurnFailed: true })).toBe("needs_you");
  });
});
