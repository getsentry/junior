import { describe, expect, it } from "vitest";

import {
  coalescedMobileViewportSyncSource,
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
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "scroll",
      }),
    ).toBe(140);
  });

  it("accepts the settled offset after the editor loses focus", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        nextOffsetTop: 0,
        previousOffsetTop: 140,
        source: "focusout",
      }),
    ).toBe(0);
  });

  it("follows blur-time scroll offsets when no editor is focused", () => {
    expect(
      mobileViewportOffsetTop({
        editableFocused: false,
        nextOffsetTop: 180,
        previousOffsetTop: 140,
        source: "scroll",
      }),
    ).toBe(180);
  });
});
