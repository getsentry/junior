import assert from "node:assert/strict";
import test from "node:test";
import {
  checkFileLengths,
  countFileLines,
  isInternalDoc,
} from "./check-file-length.mjs";

test("counts physical lines", () => {
  assert.equal(countFileLines(""), 0);
  assert.equal(countFileLines("one"), 1);
  assert.equal(countFileLines("one\n"), 1);
  assert.equal(countFileLines("one\r\ntwo\r\n"), 2);
});

test("reports an oversized file without an exception", () => {
  const [error, ...rest] = checkFileLengths(
    [{ path: "src/large.ts", lines: 1_001 }],
    {},
    1_000,
  );
  assert.deepEqual(rest, []);
  assert.match(
    error,
    /^src\/large\.ts: 1001 lines exceeds the 1000-line limit\. /,
  );
  assert.match(error, /Split it into smaller modules/);
  assert.match(error, /Do not delete code/);
});

test("accepts an oversized file with a reason", () => {
  assert.deepEqual(
    checkFileLengths(
      [{ path: "src/large.ts", lines: 1_001 }],
      { "src/large.ts": "Split this existing parser by format." },
      1_000,
    ),
    [],
  );
});

test("reports stale and invalid exceptions", () => {
  assert.deepEqual(
    checkFileLengths(
      [{ path: "src/small.ts", lines: 10 }],
      {
        "src/missing.ts": "Existing file.",
        "src/small.ts": "",
      },
      1_000,
    ),
    [
      "src/missing.ts: file-length exception points to a missing file",
      "src/small.ts: file-length exception needs a reason",
    ],
  );
});

test("selects internal docs", () => {
  assert.equal(isInternalDoc("packages/junior/src/chat/AGENTS.md"), true);
  assert.equal(isInternalDoc("packages/junior-github/README.md"), true);
  assert.equal(isInternalDoc("policies/testing.md"), true);
  assert.equal(isInternalDoc("TERMINOLOGY.md"), true);
  assert.equal(isInternalDoc("CONTRIBUTING.md"), false);
  assert.equal(isInternalDoc("packages/docs/src/content/docs/index.md"), false);
});
