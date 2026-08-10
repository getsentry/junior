import { describe, expect, it } from "vitest";

import { pageCount, pageItems } from "../src/client/components/Pagination";

describe("pageItems", () => {
  it("slices one zero-based window from a finite list", () => {
    const items = [1, 2, 3, 4, 5, 6];
    expect(pageItems(items, 1, 2)).toEqual([1, 2]);
    expect(pageItems(items, 2, 2)).toEqual([3, 4]);
    expect(pageItems(items, 3, 2)).toEqual([5, 6]);
  });

  it("clamps pages below one", () => {
    expect(pageItems([1, 2, 3], 0, 2)).toEqual([1, 2]);
  });
});

describe("pageCount", () => {
  it("returns at least one page for empty lists", () => {
    expect(pageCount(0, 25)).toBe(1);
  });

  it("rounds up partial final pages", () => {
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(50, 25)).toBe(2);
  });
});
