import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_COMMENT_BLOCK_LINES,
  checkCommentLength,
  countExcessCommentLines,
} from "./check-comment-length.mjs";

const FILE = "packages/junior/src/feature.ts";

function countIn(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-length-"));
  try {
    for (const [filePath, contents] of Object.entries(files)) {
      fs.mkdirSync(path.join(root, path.dirname(filePath)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, filePath), contents);
    }
    return countExcessCommentLines(root, ["packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lineComments(count) {
  return Array.from({ length: count }, (_, index) => `// line ${index}`);
}

test("counts adjacent line comments as one block", () => {
  const counts = countIn({
    [FILE]: [
      ...lineComments(MAX_COMMENT_BLOCK_LINES + 3),
      "export const a = 1;",
    ].join("\n"),
  });
  assert.deepEqual(counts, { [FILE]: 3 });
});

test("measures a JSDoc block by its lines", () => {
  const body = Array.from(
    { length: MAX_COMMENT_BLOCK_LINES },
    (_, index) => ` * line ${index}`,
  );
  const counts = countIn({
    [FILE]: ["/**", ...body, " */", "export function a() {}"].join("\n"),
  });
  assert.deepEqual(counts, { [FILE]: 2 });
});

test("ignores blocks within the limit, blocks split by code, and strings", () => {
  const counts = countIn({
    [FILE]: [
      ...lineComments(MAX_COMMENT_BLOCK_LINES),
      "export const a = 1;",
      ...lineComments(MAX_COMMENT_BLOCK_LINES),
      `export const b = \`${"\n// not a comment".repeat(20)}\`;`,
    ].join("\n"),
  });
  assert.deepEqual(counts, {});
});

test("reports growth and baseline entries that can shrink", () => {
  assert.deepEqual(
    checkCommentLength({ a: 1 }, { a: 1, b: 2, c: 3 }).length,
    2,
  );
  assert.match(checkCommentLength({ a: 2 }, { a: 1 })[0], /baseline allows 1/);
  assert.match(checkCommentLength({ new: 1 }, {})[0], /baseline allows 0/);
  assert.match(checkCommentLength({ c: 1 }, { c: 3 })[0], /Lower the entry/);
  assert.match(checkCommentLength({}, { b: 2 })[0], /Remove the entry/);
});
