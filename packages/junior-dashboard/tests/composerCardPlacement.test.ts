import { afterEach, describe, expect, it, vi } from "vitest";

import { cardPlacement } from "../src/client/conversations/ComposerMenu";

const REM = 16;

function box(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  } as DOMRect;
}

function viewport(width: number, height: number) {
  vi.stubGlobal("window", { innerWidth: width, innerHeight: height });
  vi.stubGlobal("document", { documentElement: {} });
  vi.stubGlobal("getComputedStyle", () => ({ fontSize: `${REM}px` }));
}

describe("cardPlacement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens below a reference near the top, at its left edge", () => {
    viewport(1440, 900);
    const composer = box(400, 100, 768, 120);
    expect(cardPlacement(composer, box(500, 120, 80, 20))).toEqual({
      left: 500,
      width: 28 * REM,
      maxHeight: 20 * REM,
      top: 140 + 0.5 * REM,
    });
  });

  it("opens above a reference near the bottom", () => {
    viewport(1440, 900);
    const composer = box(400, 780, 606, 50);
    const placement = cardPlacement(composer, box(500, 790, 80, 20));
    expect(placement.bottom).toBe(900 - 790 + 0.5 * REM);
    expect(placement.top).toBeUndefined();
  });

  it("stays over the composer when the reference is near its right edge", () => {
    viewport(1440, 900);
    const composer = box(400, 780, 606, 50);
    expect(cardPlacement(composer, box(900, 790, 80, 20)).left).toBe(
      400 + 606 - 28 * REM,
    );
  });

  it("spans a phone composer", () => {
    viewport(390, 844);
    const composer = box(8, 700, 374, 100);
    expect(cardPlacement(composer, box(120, 760, 80, 20))).toMatchObject({
      left: 8,
      width: 374,
    });
  });
});
