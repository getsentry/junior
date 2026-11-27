import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Comment length ratchet. A comment block is one comment, or a run of
 * comments on adjacent lines. A block over the limit usually restates a fact
 * that `design/`, `TELEMETRY.md`, a test, or other code owns. The baseline
 * lists each file's lines over the limit when this check was added. A count
 * can only go down.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AST_GREP = path.join(REPO_ROOT, "node_modules/.bin/ast-grep");
const BASELINE_PATH = "scripts/comment-length-baseline.json";
const SCAN_DIRECTORIES = ["packages", "scripts", "tools"];
export const MAX_COMMENT_BLOCK_LINES = 12;
const MESSAGE =
  "Cut the comment to what the code and the doc that owns the fact do not say. Do not split it into smaller comments to pass. See policies/code-comments.md.";

const RULES = ["TypeScript", "Tsx", "JavaScript"]
  .map(
    (language) => `id: comment-${language}
language: ${language}
rule: { kind: comment }`,
  )
  .join("\n---\n");

/**
 * Return the lines over the limit per file. Comments on adjacent lines count
 * as one block, so a run of `//` lines is measured like one JSDoc. Paths in
 * the result are relative to `root`.
 */
export function countExcessCommentLines(root, targets) {
  const output = execFileSync(
    AST_GREP,
    ["scan", "--inline-rules", RULES, "--json=stream", ...targets],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const rangesByFile = new Map();
  for (const line of output.split("\n")) {
    if (!line) continue;
    const match = JSON.parse(line);
    const file = match.file.split(path.sep).join("/");
    const ranges = rangesByFile.get(file) ?? [];
    ranges.push([match.range.start.line, match.range.end.line]);
    rangesByFile.set(file, ranges);
  }
  const counts = {};
  for (const [file, ranges] of rangesByFile) {
    ranges.sort((a, b) => a[0] - b[0]);
    let excess = 0;
    let block;
    for (const [start, end] of [...ranges, [Infinity, Infinity]]) {
      if (block && start <= block[1] + 1) {
        block[1] = Math.max(block[1], end);
        continue;
      }
      if (block) {
        excess += Math.max(
          0,
          block[1] - block[0] + 1 - MAX_COMMENT_BLOCK_LINES,
        );
      }
      block = [start, end];
    }
    if (excess > 0) counts[file] = excess;
  }
  return counts;
}

/**
 * Report files with more excess lines than the baseline allows, and baseline
 * entries that are now too high, so the baseline only gets smaller.
 */
export function checkCommentLength(counts, baseline) {
  const errors = [];
  for (const [filePath, actual] of Object.entries(counts)) {
    const allowed = baseline[filePath] ?? 0;
    if (actual > allowed) {
      errors.push(
        `${filePath}: ${actual} comment lines over the ${MAX_COMMENT_BLOCK_LINES}-line block limit, baseline allows ${allowed}. ${MESSAGE}`,
      );
    }
  }
  for (const [filePath, allowed] of Object.entries(baseline)) {
    const actual = counts[filePath] ?? 0;
    if (actual < allowed) {
      errors.push(
        actual === 0
          ? `${filePath}: no comment lines over the limit, baseline allows ${allowed}. Remove the entry from ${BASELINE_PATH}.`
          : `${filePath}: ${actual} comment lines over the limit, baseline allows ${allowed}. Lower the entry in ${BASELINE_PATH} to ${actual}.`,
      );
    }
  }
  return errors;
}

/** Check that no comment block grows past the limit. */
export function run() {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  );
  const targets = SCAN_DIRECTORIES.filter((directory) =>
    fs.existsSync(path.join(REPO_ROOT, directory)),
  );
  const errors = checkCommentLength(
    countExcessCommentLines(REPO_ROOT, targets),
    baseline,
  );
  if (errors.length === 0) return [];
  return [
    ...errors,
    `Do not add or raise entries in ${BASELINE_PATH} to pass. When you move a file, move its entry.`,
  ];
}
