import { describe, expect, it } from "vitest";

import { hoverPreviewVisible } from "../src/client/components/ui/hover-preview";

type Render = { allowed: boolean; open: boolean };

// Each render gets the last render's result as `shown`, as `HoverPreview`
// keeps it.
function renders(steps: Render[]): boolean[] {
  let shown = false;
  return steps.map((step) => {
    shown = hoverPreviewVisible({ ...step, shown });
    return shown;
  });
}

describe("hoverPreviewVisible", () => {
  it("keeps a shown card when the gate closes", () => {
    expect(
      renders([
        { allowed: true, open: true },
        { allowed: false, open: true },
      ]),
    ).toEqual([true, true]);
  });

  it("holds a card back while the gate is closed before it shows", () => {
    expect(
      renders([
        { allowed: false, open: true },
        { allowed: true, open: true },
      ]),
    ).toEqual([false, true]);
  });

  it("holds the next card back once the card closes", () => {
    expect(
      renders([
        { allowed: true, open: true },
        { allowed: true, open: false },
        { allowed: false, open: true },
      ]),
    ).toEqual([true, false, false]);
  });
});
