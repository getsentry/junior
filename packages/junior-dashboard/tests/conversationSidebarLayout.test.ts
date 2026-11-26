import { describe, expect, it } from "vitest";

import { defaultDetailsWidth } from "@dashboard/conversations/conversationSidebarLayout";

function rem(columnRem: number): number {
  return parseFloat(defaultDetailsWidth(columnRem));
}

describe("defaultDetailsWidth", () => {
  it("keeps the 25rem laptop width when a share of the column is narrower", () => {
    // A 1280px window with the pane open leaves a 62rem column.
    expect(rem(62)).toBe(25);
  });

  it("takes 35% of a wide column", () => {
    // A 1920px window with the pane open leaves a 102rem column.
    expect(rem(102)).toBeCloseTo(35.7);
  });

  it("stops growing at 50rem on a very wide column", () => {
    expect(rem(300)).toBe(50);
  });
});
