import { describe, expect, it } from "vitest";

import { codeChangeSize } from "../src/client/codeChangeSize";

describe("code change size", () => {
  it("shortens counts and names them in full", () => {
    expect(
      codeChangeSize({ additions: 1204, changedFiles: 12, deletions: 340 }),
    ).toEqual({
      added: "+1.2k",
      files: "12 files",
      label: "1,204 lines added, 340 removed, 12 files changed",
      removed: "−340",
    });
    expect(
      codeChangeSize({ additions: 999, changedFiles: 1, deletions: 12_345 }),
    ).toEqual({
      added: "+999",
      files: "1 file",
      label: "999 lines added, 12,345 removed, 1 file changed",
      removed: "−12k",
    });
  });

  it("leaves out the parts it does not know", () => {
    expect(codeChangeSize({ deletions: 1 })).toEqual({
      label: "1 line removed",
      removed: "−1",
    });
    expect(codeChangeSize({ changedFiles: 3 })).toEqual({
      files: "3 files",
      label: "3 files changed",
    });
    expect(codeChangeSize({ additions: 0, deletions: 0 })).toEqual({
      added: "+0",
      label: "0 lines added, 0 removed",
      removed: "−0",
    });
    expect(codeChangeSize({})).toBeUndefined();
    expect(codeChangeSize(undefined)).toBeUndefined();
  });
});
