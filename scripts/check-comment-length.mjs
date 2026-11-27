import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Comment size ratchet: a block has at most 5 text lines, and no comment line
 * is wider than 80 columns, so a block holds at most about 400 characters.
 * The baseline holds each file's excess per rule and may only shrink.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AST_GREP = path.join(REPO_ROOT, "node_modules/.bin/ast-grep");
const BASELINE_PATH = "scripts/comment-length-baseline.json";
const SCAN_DIRECTORIES = ["packages", "scripts", "tools"];
export const MAX_BLOCK_LINES = 5;
export const MAX_LINE_WIDTH = 80;
// `/**`, `*/`, and empty comment lines hold no text.
const DELIMITER_LINE = /^\s*(?:\/\*\*?|\*\/|\*|\/\/)\s*$/;
// Links and tool directives cannot wrap.
const UNWRAPPABLE =
  /https?:\/\/|(?:oxlint|eslint)-(?:disable|enable)|@ts-|ast-grep-ignore/;
const RULES = ["TypeScript", "Tsx", "JavaScript"]
  .map(
    (language) => `id: comment-${language}
language: ${language}
rule: { kind: comment }`,
  )
  .join("\n---\n");
const MESSAGES = {
  "block-lines": `Cut the comment to what the code and the doc that owns the fact do not say. Do not split it into adjacent comments to pass.`,
  "line-width": `Wrap the comment at ${MAX_LINE_WIDTH} columns, then cut it if the block grows past ${MAX_BLOCK_LINES} lines.`,
};

/**
 * Merge comments on adjacent lines into blocks. Ranges are 0-based
 * `[start, end]` line pairs.
 */
function mergeBlocks(ranges) {
  const blocks = [];
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const last = blocks.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else blocks.push([start, end]);
  }
  return blocks;
}

/** Return each file's excess per rule. Paths are relative to `root`. */
export function measureComments(root, targets) {
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
  const counts = { "block-lines": {}, "line-width": {} };
  for (const [file, ranges] of rangesByFile) {
    const source = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    let excess = 0;
    let wide = 0;
    for (const [start, end] of mergeBlocks(ranges)) {
      const lines = source.slice(start, end + 1);
      const text = lines.filter((line) => !DELIMITER_LINE.test(line));
      excess += Math.max(0, text.length - MAX_BLOCK_LINES);
      wide += lines.filter(
        (line) => line.length > MAX_LINE_WIDTH && !UNWRAPPABLE.test(line),
      ).length;
    }
    if (excess > 0) counts["block-lines"][file] = excess;
    if (wide > 0) counts["line-width"][file] = wide;
  }
  return counts;
}

/**
 * Report files over their baseline, and baseline entries that are now too
 * high, so the baseline only gets smaller.
 */
export function checkCommentLength(counts, baseline) {
  const errors = [];
  for (const [rule, ruleCounts] of Object.entries(counts)) {
    const allowedByFile = baseline[rule] ?? {};
    for (const [filePath, actual] of Object.entries(ruleCounts)) {
      const allowed = allowedByFile[filePath] ?? 0;
      if (actual > allowed) {
        errors.push(
          `${filePath}: ${rule} ${actual}, baseline allows ${allowed}. ${MESSAGES[rule]}`,
        );
      }
    }
    for (const [filePath, allowed] of Object.entries(allowedByFile)) {
      const actual = ruleCounts[filePath] ?? 0;
      if (actual < allowed) {
        errors.push(
          actual === 0
            ? `${filePath}: ${rule} 0, baseline allows ${allowed}. Remove the entry from ${BASELINE_PATH}.`
            : `${filePath}: ${rule} ${actual}, baseline allows ${allowed}. Lower the entry in ${BASELINE_PATH} to ${actual}.`,
        );
      }
    }
  }
  return errors;
}

/** Check that no comment grows past the size limits. */
export function run() {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  );
  const targets = SCAN_DIRECTORIES.filter((directory) =>
    fs.existsSync(path.join(REPO_ROOT, directory)),
  );
  const errors = checkCommentLength(
    measureComments(REPO_ROOT, targets),
    baseline,
  );
  if (errors.length === 0) return [];
  return [
    ...errors,
    `See policies/code-comments.md. Do not add or raise entries in ${BASELINE_PATH} to pass. When you move a file, move its entry.`,
  ];
}
