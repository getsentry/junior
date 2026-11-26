import { describe, expect, it } from "vitest";
import { spaceDisplayState } from "../src/client/spaces/SpaceStateIcon";

describe("spaceDisplayState", () => {
  it("orders needs_you, failed, then working, and shows nothing when idle", () => {
    expect(
      spaceDisplayState({ latestTurnFailed: true, treeState: "needs_you" }),
    ).toBe("needs_you");
    expect(
      spaceDisplayState({ latestTurnFailed: true, treeState: "working" }),
    ).toBe("failed");
    expect(
      spaceDisplayState({ latestTurnFailed: false, treeState: "working" }),
    ).toBe("working");
    expect(
      spaceDisplayState({ latestTurnFailed: false, treeState: "done" }),
    ).toBeUndefined();
  });
});
