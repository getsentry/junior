import { describe, expect, it } from "vitest";

import {
  mobileViewportMetrics,
  mobileViewportOffsetTop,
} from "../src/client/mobileViewport";

describe("mobileViewportMetrics", () => {
  it("clears shell geometry off mobile", () => {
    expect(
      mobileViewportMetrics({
        layoutHeight: 900,
        mobile: false,
        visualHeight: 900,
        visualOffsetTop: 40,
      }),
    ).toBeNull();
  });

  it("ignores rubber-band offset while the keyboard is closed", () => {
    expect(
      mobileViewportMetrics({
        layoutHeight: 844,
        mobile: true,
        visualHeight: 844,
        visualOffsetTop: 48,
      }),
    ).toEqual({
      heightPx: 844,
      offsetTopPx: 0,
    });
  });

  it("ignores small visual height jitter while the keyboard is closed", () => {
    expect(
      mobileViewportMetrics({
        layoutHeight: 844,
        mobile: true,
        visualHeight: 820,
        visualOffsetTop: 12,
      }),
    ).toEqual({
      heightPx: 844,
      offsetTopPx: 0,
    });
  });

  it("tracks visual viewport geometry while the keyboard is open", () => {
    expect(
      mobileViewportMetrics({
        layoutHeight: 844,
        mobile: true,
        visualHeight: 520,
        visualOffsetTop: 140,
      }),
    ).toEqual({
      heightPx: 520,
      offsetTopPx: 140,
    });
  });

  it("never reports a negative keyboard offset", () => {
    expect(
      mobileViewportMetrics({
        layoutHeight: 844,
        mobile: true,
        visualHeight: 480,
        visualOffsetTop: -12,
      }),
    ).toEqual({
      heightPx: 480,
      offsetTopPx: 0,
    });
  });
});

describe("mobileViewportOffsetTop", () => {
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
