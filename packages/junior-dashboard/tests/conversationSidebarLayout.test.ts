import { describe, expect, it } from "vitest";

import { defaultDetailsWidth } from "@dashboard/conversations/conversationSidebarLayout";

function rem(columnRem: number): number {
  return parseFloat(defaultDetailsWidth(columnRem));
}

describe("defaultDetailsWidth", () => {
  it("keeps the 25rem laptop width when a share of the column is narrower", () => {
    // A 1280px window with the pane open leaves a 62rem column.
    expect(rem(62)).toBe(25);
    // A 1440px window leaves 72rem, and 35% of it rounds down to 25rem.
    expect(rem(72)).toBe(25);
  });

  it("takes 35% of a wide column, in whole rem", () => {
    // A 1920px window with the pane open leaves a 102rem column.
    expect(rem(102)).toBe(35);
  });

  it("stops growing at 50rem on a very wide column", () => {
    expect(rem(300)).toBe(50);
  });
});
