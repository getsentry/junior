import { describe, expect, it } from "vitest";

import { scrollAnchorIndex } from "../src/client/conversations/transcriptScrollAnchor";

const rows = [
  { top: 0, bottom: 100 },
  { top: 100, bottom: 400 },
  { top: 400, bottom: 450 },
  { top: 450, bottom: 900 },
];
const rowAt = (index: number) => rows[index]!;

describe("scrollAnchorIndex", () => {
  it("picks the first row that starts inside the viewport", () => {
    expect(
      scrollAnchorIndex(rows.length, rowAt, { top: 50, bottom: 350 }),
    ).toBe(1);
    expect(
      scrollAnchorIndex(rows.length, rowAt, { top: 100, bottom: 350 }),
    ).toBe(1);
  });

  it("keeps a tall row that covers the whole viewport", () => {
    expect(
      scrollAnchorIndex(rows.length, rowAt, { top: 500, bottom: 800 }),
    ).toBe(3);
    expect(
      scrollAnchorIndex(rows.length, rowAt, { top: 150, bottom: 380 }),
    ).toBe(1);
  });

  it("finds no anchor below the last row", () => {
    expect(
      scrollAnchorIndex(rows.length, rowAt, { top: 900, bottom: 1_200 }),
    ).toBeNull();
    expect(scrollAnchorIndex(0, rowAt, { top: 0, bottom: 300 })).toBeNull();
  });
});
