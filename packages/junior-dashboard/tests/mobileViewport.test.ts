import { describe, expect, it } from "vitest";

import {
  coalescedMobileViewportSyncSource,
  mobileViewportMetrics,
  mobileViewportOffsetTop,
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

  it("detects resizes-content keyboard open from a non-zero visual offset", () => {
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
      offsetTopPx: 120,
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

describe("coalescedMobileViewportSyncSource", () => {
  it("keeps keyboard resize stronger than a same-frame scroll", () => {
    expect(coalescedMobileViewportSyncSource("resize", "scroll")).toBe(
      "resize",
    );
    expect(coalescedMobileViewportSyncSource("scroll", "resize")).toBe(
      "resize",
    );
  });

  it("uses scroll when it is the only signal in a frame", () => {
    expect(coalescedMobileViewportSyncSource(undefined, "scroll")).toBe(
      "scroll",
    );
  });
});

describe("mobileViewportOffsetTop", () => {
  it("docks to the keyboard offset on first focus resize", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardOpen: true,
        nextOffsetTop: 140,
        previousOffsetTop: 0,
        source: "resize",
      }),
    ).toBe(140);
  });

  it("keeps the shell still while Safari pans a focused editor", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardOpen: true,
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "scroll",
      }),
    ).toBe(140);
  });

  it("freezes measure and focus churn while an editor is focused", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardOpen: true,
        nextOffsetTop: 200,
        previousOffsetTop: 140,
        source: "measure",
      }),
    ).toBe(140);
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardOpen: true,
        nextOffsetTop: 200,
        previousOffsetTop: 140,
        source: "focusin",
      }),
    ).toBe(140);
  });

  it("snaps closed after the editor loses focus", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        keyboardOpen: false,
        nextOffsetTop: 0,
        previousOffsetTop: 140,
        source: "focusout",
      }),
    ).toBe(0);
  });

  it("snaps closed even if a stale visual offset remains after blur", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        keyboardOpen: false,
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "focusout",
      }),
    ).toBe(0);
  });

  it("follows open-keyboard scroll offsets when no editor is focused", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        keyboardOpen: true,
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "scroll",
      }),
    ).toBe(180);
  });
});
