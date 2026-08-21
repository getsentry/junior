import { describe, expect, it } from "vitest";

import {
  mobileViewportMetrics,
  nextRestingLayoutHeight,
} from "../src/client/mobileViewport";

describe("mobileViewportMetrics", () => {
  it("clears shell geometry off mobile", () => {
    expect(
      mobileViewportMetrics({
        editableFocused: false,
        layoutHeight: 900,
        mobile: false,
        restingLayoutHeight: 900,
        visualHeight: 900,
        visualOffsetTop: 40,
      }),
    ).toBeNull();
  });

  it("ignores rubber-band offset while the keyboard is closed", () => {
    expect(
      mobileViewportMetrics({
        editableFocused: false,
        layoutHeight: 844,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 844,
        visualOffsetTop: 48,
      }),
    ).toEqual({
      heightPx: 844,
      keyboardOpen: false,
      offsetTopPx: 0,
    });
  });

  it("ignores small visual height jitter while the keyboard is closed", () => {
    expect(
      mobileViewportMetrics({
        editableFocused: false,
        layoutHeight: 844,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 820,
        visualOffsetTop: 12,
      }),
    ).toEqual({
      heightPx: 844,
      keyboardOpen: false,
      offsetTopPx: 0,
    });
  });

  it("tracks visual viewport geometry while the keyboard is open", () => {
    expect(
      mobileViewportMetrics({
        editableFocused: true,
        layoutHeight: 844,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 520,
        visualOffsetTop: 140,
      }),
    ).toEqual({
      heightPx: 520,
      keyboardOpen: true,
      offsetTopPx: 140,
    });
  });

  it("detects keyboard open when resizes-content shrinks layout and visual together with focus", () => {
    // interactive-widget=resizes-content shrinks both viewports. Without a
    // resting closed height, layout-vs-visual delta stays near zero.
    expect(
      mobileViewportMetrics({
        editableFocused: true,
        layoutHeight: 520,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 520,
        visualOffsetTop: 0,
      }),
    ).toEqual({
      heightPx: 520,
      keyboardOpen: true,
      offsetTopPx: 0,
    });
  });

  it("zeros leftover visual offset when layout already matches the visible band", () => {
    // Hybrid WebKit can still report offsetTop after layout shrank. Trusting
    // that offset shoves the fixed shell under the keyboard.
    expect(
      mobileViewportMetrics({
        editableFocused: false,
        layoutHeight: 520,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 520,
        visualOffsetTop: 120,
      }),
    ).toEqual({
      heightPx: 520,
      keyboardOpen: true,
      offsetTopPx: 0,
    });
  });

  it("does not treat orientation shrink as a stuck keyboard open", () => {
    // Portrait resting height left behind after rotating closed to landscape.
    // Height alone must not lock keyboard-open forever without focus/offset.
    expect(
      mobileViewportMetrics({
        editableFocused: false,
        layoutHeight: 390,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 390,
        visualOffsetTop: 0,
      }),
    ).toEqual({
      heightPx: 390,
      keyboardOpen: false,
      offsetTopPx: 0,
    });
  });

  it("never reports a negative keyboard offset", () => {
    expect(
      mobileViewportMetrics({
        editableFocused: true,
        layoutHeight: 844,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 480,
        visualOffsetTop: -12,
      }),
    ).toEqual({
      heightPx: 480,
      keyboardOpen: true,
      offsetTopPx: 0,
    });
  });

  it("caps offset so top + height never exceeds layout height", () => {
    expect(
      mobileViewportMetrics({
        editableFocused: true,
        layoutHeight: 700,
        mobile: true,
        restingLayoutHeight: 844,
        visualHeight: 520,
        visualOffsetTop: 250,
      }),
    ).toEqual({
      heightPx: 520,
      keyboardOpen: true,
      offsetTopPx: 180,
    });
  });
});

describe("nextRestingLayoutHeight", () => {
  it("follows the current layout height while the keyboard is closed", () => {
    expect(
      nextRestingLayoutHeight({
        keyboardOpen: false,
        layoutHeight: 390,
        previousRestingLayoutHeight: 844,
      }),
    ).toBe(390);
  });

  it("keeps the previous resting height while the keyboard is open", () => {
    expect(
      nextRestingLayoutHeight({
        keyboardOpen: true,
        layoutHeight: 520,
        previousRestingLayoutHeight: 844,
      }),
    ).toBe(844);
  });

  it("drops a tall desktop resting height when later measuring closed mobile layout", () => {
    // Desktop effect path refreshes resting while metrics are null. Without
    // that, a focused resize below 768px would false-positive keyboard-open.
    const afterDesktop = nextRestingLayoutHeight({
      keyboardOpen: false,
      layoutHeight: 900,
      previousRestingLayoutHeight: 900,
    });
    const afterMobileClosed = nextRestingLayoutHeight({
      keyboardOpen: false,
      layoutHeight: 700,
      previousRestingLayoutHeight: afterDesktop,
    });
    expect(afterMobileClosed).toBe(700);
    expect(
      mobileViewportMetrics({
        editableFocused: true,
        layoutHeight: 700,
        mobile: true,
        restingLayoutHeight: afterMobileClosed,
        visualHeight: 700,
        visualOffsetTop: 0,
      }),
    ).toEqual({
      heightPx: 700,
      keyboardOpen: false,
      offsetTopPx: 0,
    });
  });
});
