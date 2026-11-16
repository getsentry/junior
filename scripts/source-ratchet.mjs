import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Per-file count ratchet for a pattern in production source. A baseline lists
 * the count per file that existed when a check was added. A count can only go
 * down, so a common pattern stops growing without a fix for every old site.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AST_GREP = path.join(REPO_ROOT, "node_modules/.bin/ast-grep");
// Test harness packages. They are not production source.
const EXCLUDED_PACKAGES = new Set(["junior-evals", "junior-testing"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$|\/(?:__tests__|fixtures?)\//;

/** Say whether a repository path is production source that a ratchet counts. */
export function isCheckedFile(filePath) {
  const [group, packageName, sourceDirectory] = filePath.split("/");
  return (
    group === "packages" &&
    sourceDirectory === "src" &&
    !EXCLUDED_PACKAGES.has(packageName) &&
    !TEST_FILE.test(filePath)
  );
}

/**
 * Count ast-grep rule matches per file with the TypeScript parser, so
 * comments and strings are not counted. Paths in the result are relative to
 * `root`.
 */
export function countMatches(root, targets, rules) {
  const output = execFileSync(
    AST_GREP,
    ["scan", "--inline-rules", rules, "--json=stream", ...targets],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const counts = {};
  for (const line of output.split("\n")) {
    if (!line) continue;
    const file = JSON.parse(line).file.split(path.sep).join("/");
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

/**
 * Report files with more matches than the baseline allows, and baseline
 * entries that are now too high, so the baseline only gets smaller.
 */
export function compareToBaseline(counts, baseline, ratchet) {
  const { label, message, baselinePath } = ratchet;
  const errors = [];
  for (const [filePath, actual] of Object.entries(counts)) {
    const allowed = baseline[filePath] ?? 0;
    if (actual > allowed) {
      errors.push(
        `${filePath}: ${label}: ${actual} found, baseline allows ${allowed}. ${message}`,
      );
    }
  }
  for (const [filePath, allowed] of Object.entries(baseline)) {
    const actual = counts[filePath] ?? 0;
    if (actual < allowed) {
      errors.push(
        actual === 0
          ? `${filePath}: ${label}: 0 found, baseline allows ${allowed}. Remove the entry from ${baselinePath}.`
          : `${filePath}: ${label}: ${actual} found, baseline allows ${allowed}. Lower the entry in ${baselinePath} to ${actual}.`,
      );
    }
  }
  return errors;
}

function sourceDirectories(root) {
  return fs
    .readdirSync(path.join(root, "packages"))
    .filter((name) => !EXCLUDED_PACKAGES.has(name))
    .map((name) => `packages/${name}/src`)
    .filter((directory) => fs.existsSync(path.join(root, directory)));
}

/** Run one ratchet over production source and set the exit code. */
export function runRatchet(ratchet) {
  const { rules, baselinePath, title, passMessage } = ratchet;
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, baselinePath), "utf8"),
  );
  const counts = Object.fromEntries(
    Object.entries(
      countMatches(REPO_ROOT, sourceDirectories(REPO_ROOT), rules),
    ).filter(([filePath]) => isCheckedFile(filePath)),
  );
  const errors = compareToBaseline(counts, baseline, ratchet);
  if (errors.length === 0) {
    console.log(passMessage);
    return;
  }
  console.error(
    [
      `${title} check failed:`,
      ...errors,
      `Fix the code. Do not hide the pattern in a helper, and do not add or raise entries in ${baselinePath}, to pass. When you move a file, move its entry.`,
    ].join("\n"),
  );
  process.exitCode = 1;
}
