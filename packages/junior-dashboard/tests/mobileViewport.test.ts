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
      keyboardMode: "closed",
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
      keyboardMode: "closed",
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
      keyboardMode: "resizes-visual",
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
      keyboardMode: "resizes-content",
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
      keyboardMode: "resizes-content",
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
      keyboardMode: "closed",
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
      keyboardMode: "resizes-visual",
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
      keyboardMode: "closed",
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
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 140,
        previousOffsetTop: 0,
        source: "resize",
      }),
    ).toBe(140);
  });

  it("accepts a first significant keyboard dock from non-resize sources while undocked under resizes-visual", () => {
    for (const source of ["scroll", "focusin", "measure"] as const) {
      expect(
        mobileViewportOffsetTop({
          editableFocused: true,
          keyboardMode: "resizes-visual",
          keyboardOpen: true,
          nextOffsetTop: 140,
          previousOffsetTop: 0,
          source,
        }),
        source,
      ).toBe(140);
    }
  });

  it("ignores tiny offset jitter before the real first dock under resizes-visual", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 12,
        previousOffsetTop: 0,
        source: "scroll",
      }),
    ).toBe(0);
  });

  it("freezes non-resize caret pans under resizes-content even while offset is still zero", () => {
    // interactive-widget=resizes-content keeps offset 0 as the steady open
    // geometry. A later caret pan must not steal the shell.
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardMode: "resizes-content",
        keyboardOpen: true,
        nextOffsetTop: 48,
        previousOffsetTop: 0,
        source: "scroll",
      }),
    ).toBe(0);
  });

  it("keeps the shell still while Safari later pans a focused editor", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "scroll",
      }),
    ).toBe(140);
  });

  it("freezes measure and focus churn after the shell is already docked", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 200,
        previousOffsetTop: 140,
        source: "measure",
      }),
    ).toBe(140);
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 200,
        previousOffsetTop: 140,
        source: "focusin",
      }),
    ).toBe(140);
  });

  it("still follows keyboard resize after the first dock", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: true,
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 160,
        previousOffsetTop: 140,
        source: "resize",
      }),
    ).toBe(160);
  });

  it("walks the iOS first-focus dock sequence without drifting", () => {
    // 1. Keyboard opens: height shrinks, offset still 0 for a frame.
    let offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-visual",
      keyboardOpen: true,
      nextOffsetTop: 0,
      previousOffsetTop: 0,
      source: "resize",
    });
    expect(offset).toBe(0);

    // 2. Tiny jitter before the real dock must not lock the shell.
    offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-visual",
      keyboardOpen: true,
      nextOffsetTop: 8,
      previousOffsetTop: offset,
      source: "scroll",
    });
    expect(offset).toBe(0);

    // 3. First real dock arrives as scroll (the physical-iPhone failure mode).
    offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-visual",
      keyboardOpen: true,
      nextOffsetTop: 140,
      previousOffsetTop: offset,
      source: "scroll",
    });
    expect(offset).toBe(140);

    // 4. Later caret pan must not chase.
    offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-visual",
      keyboardOpen: true,
      nextOffsetTop: 180,
      previousOffsetTop: offset,
      source: "scroll",
    });
    expect(offset).toBe(140);

    // 5. Keyboard animation may still move the dock via resize.
    offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-visual",
      keyboardOpen: true,
      nextOffsetTop: 160,
      previousOffsetTop: offset,
      source: "resize",
    });
    expect(offset).toBe(160);

    // 6. Blur snaps closed even with a stale visual offset.
    offset = mobileViewportOffsetTop({
      editableFocused: false,
      keyboardMode: "closed",
      keyboardOpen: false,
      nextOffsetTop: 160,
      previousOffsetTop: offset,
      source: "focusout",
    });
    expect(offset).toBe(0);
  });

  it("walks the resizes-content open sequence without caret-pan drift", () => {
    // 1. Both viewports shrink together; offset stays 0.
    let offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-content",
      keyboardOpen: true,
      nextOffsetTop: 0,
      previousOffsetTop: 0,
      source: "resize",
    });
    expect(offset).toBe(0);

    // 2. Later caret pan must not move the shell.
    offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-content",
      keyboardOpen: true,
      nextOffsetTop: 48,
      previousOffsetTop: offset,
      source: "scroll",
    });
    expect(offset).toBe(0);

    // 3. Resize may still move the dock if the browser reports one.
    offset = mobileViewportOffsetTop({
      editableFocused: true,
      keyboardMode: "resizes-content",
      keyboardOpen: true,
      nextOffsetTop: 20,
      previousOffsetTop: offset,
      source: "resize",
    });
    expect(offset).toBe(20);
  });

  it("snaps closed after the editor loses focus", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        keyboardMode: "closed",
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
        keyboardMode: "closed",
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
        keyboardMode: "resizes-visual",
        keyboardOpen: true,
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "scroll",
      }),
    ).toBe(180);
  });
});
