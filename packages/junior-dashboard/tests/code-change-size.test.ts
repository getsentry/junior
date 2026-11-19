import { describe, expect, it } from "vitest";

import { codeChangeSize } from "../src/client/codeChangeSize";

describe("code change size", () => {
  it("shortens counts and names them in full", () => {
    expect(
      codeChangeSize({ additions: 1204, changedFiles: 12, deletions: 340 }),
    ).toEqual({
      label: "1,204 lines added, 340 removed, 12 files changed",
      short: "+1.2k −340 · 12 files",
    });
    expect(
      codeChangeSize({ additions: 999, changedFiles: 1, deletions: 12_345 }),
    ).toEqual({
      label: "999 lines added, 12,345 removed, 1 file changed",
      short: "+999 −12k · 1 file",
    });
  });

  it("leaves out the parts it does not know", () => {
    expect(codeChangeSize({ deletions: 1 })).toEqual({
      label: "1 line removed",
      short: "−1",
    });
    expect(codeChangeSize({ changedFiles: 3 })).toEqual({
      label: "3 files changed",
      short: "3 files",
    });
    expect(codeChangeSize({ additions: 0, deletions: 0 })).toEqual({
      label: "0 lines added, 0 removed",
      short: "+0 −0",
    });
    expect(codeChangeSize({})).toBeUndefined();
    expect(codeChangeSize(undefined)).toBeUndefined();
  });
});
