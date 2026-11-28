import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SpaceStateIcon,
  spaceDisplayState,
} from "../src/client/spaces/SpaceStateIcon";

describe("spaceDisplayState", () => {
  it("orders needs_input, failed, then working, and shows nothing when idle", () => {
    expect(
      spaceDisplayState({ latestTurnFailed: true, treeState: "needs_input" }),
    ).toBe("needs_input");
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

  it("names a Space's failed child a Thread", () => {
    expect(
      renderToStaticMarkup(createElement(SpaceStateIcon, { state: "failed" })),
    ).toContain('aria-label="A Thread failed"');
  });
});
