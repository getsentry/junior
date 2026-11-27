import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_BLOCK_LINES,
  MAX_LINE_WIDTH,
  checkCommentLength,
  measureComments,
} from "./check-comment-length.mjs";

const FILE = "packages/junior/src/feature.ts";

function measure(lines) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-length-"));
  try {
    fs.mkdirSync(path.join(root, path.dirname(FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, FILE), lines.join("\n"));
    return measureComments(root, ["packages"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function lineComments(count) {
  return Array.from({ length: count }, (_, index) => `// line ${index}`);
}

test("counts adjacent line comments as one block", () => {
  const counts = measure([
    ...lineComments(MAX_BLOCK_LINES + 3),
    "export const a = 1;",
  ]);
  assert.deepEqual(counts["block-lines"], { [FILE]: 3 });
});

test("counts JSDoc text lines, not its delimiters or blank lines", () => {
  const body = Array.from({ length: MAX_BLOCK_LINES }, (_, i) => ` * ${i}`);
  const within = measure(["/**", ...body, " *", " */", "function a() {}"]);
  assert.deepEqual(within["block-lines"], {});
  const over = measure(["/**", ...body, " * more", " */", "function a() {}"]);
  assert.deepEqual(over["block-lines"], { [FILE]: 1 });
  const plain = body.map((line) => line.replace(" * ", "   "));
  const unstarred = measure(["/*", ...plain, "", "   ", "*/", "let a;"]);
  assert.deepEqual(unstarred["block-lines"], {});
});

test("ignores blocks split by code, and comment text in strings", () => {
  const counts = measure([
    ...lineComments(MAX_BLOCK_LINES),
    "export const a = 1;",
    ...lineComments(MAX_BLOCK_LINES),
    `export const b = \`${"\n// not a comment".repeat(20)}\`;`,
  ]);
  assert.deepEqual(counts, { "block-lines": {}, "line-width": {} });
});

test("keeps trailing comments out of blocks", () => {
  const trailing = Array.from(
    { length: MAX_BLOCK_LINES + 3 },
    (_, index) => `const v${index} = ${index}; // note`,
  );
  const counts = measure([...lineComments(MAX_BLOCK_LINES), ...trailing]);
  assert.deepEqual(counts["block-lines"], {});
});

test("measures a multiline block comment that starts after code", () => {
  const body = Array.from({ length: MAX_BLOCK_LINES + 1 }, (_, i) => ` * ${i}`);
  const counts = measure(["const a = 1; /* start", ...body, " */"]);
  assert.deepEqual(counts["block-lines"], { [FILE]: 2 });
});

test("measures JSX comments like other comments", () => {
  const file = "packages/junior/src/view.tsx";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "comment-length-"));
  try {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    const lines = Array.from(
      { length: MAX_BLOCK_LINES + 1 },
      (_, index) => `    {/* line ${index} */}`,
    );
    const body = Array.from({ length: MAX_BLOCK_LINES }, (_, i) => `    ${i}`);
    fs.writeFileSync(
      path.join(root, file),
      [
        "export const A = () => (",
        "  <div>",
        ...lines,
        "    <span />",
        "    {/*",
        ...body,
        "    */}",
        "  </div>",
        ");",
      ].join("\n"),
    );
    const counts = measureComments(root, ["packages"]);
    assert.deepEqual(counts["block-lines"], { [file]: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("counts wide comment lines, except links and directives", () => {
  const long = "x".repeat(MAX_LINE_WIDTH);
  const counts = measure([
    `// ${long}`,
    "const a = 1;",
    `// https://example.com/${long}`,
    "const b = 2;",
    `// oxlint-disable-next-line no-console -- ${long}`,
    "const c = 3;",
  ]);
  assert.deepEqual(counts["line-width"], { [FILE]: 1 });
});

test("reports growth and baseline entries that can shrink", () => {
  const check = (counts, baseline) =>
    checkCommentLength({ "line-width": {}, ...counts }, baseline);
  assert.match(
    check({ "block-lines": { a: 2 } }, { "block-lines": { a: 1 } })[0],
    /baseline allows 1/,
  );
  assert.match(check({ "block-lines": { a: 1 } }, {})[0], /allows 0/);
  assert.match(
    check({ "block-lines": { a: 1 } }, { "block-lines": { a: 3 } })[0],
    /Lower the entry/,
  );
  assert.match(
    check({ "block-lines": {} }, { "block-lines": { a: 3 } })[0],
    /Remove the entry/,
  );
});
