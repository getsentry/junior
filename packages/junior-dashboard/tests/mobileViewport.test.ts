import { describe, expect, it } from "vitest";

import { mobileViewportOffsetTop } from "../src/client/mobileViewport";

describe("mobile viewport", () => {
  it("keeps the shell still while Safari pans a focused editor", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        nextOffsetTop: 128,
        previousOffsetTop: 0,
      }),
    ).toBe(0);
  });

  it("accepts the settled offset after the editor loses focus", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        nextOffsetTop: 0,
        previousOffsetTop: 128,
      }),
    ).toBe(0);
  });
});
