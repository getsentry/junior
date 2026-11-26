import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Env ratchet for `packages/junior/src`. The app gets a resolved config from
 * `loadConfig` in `src/config.ts`, so code that reads `process.env` itself
 * depends on process-wide state that tests cannot set per test. Only the config
 * layer and the entrypoints that hand env to it read `process.env`. The
 * baseline lists the per-file count of the reads that existed when this check
 * was added. A count can only go down.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AST_GREP = path.join(REPO_ROOT, "node_modules/.bin/ast-grep");
const BASELINE_PATH = "scripts/process-env-baseline.json";
const SOURCE = "packages/junior/src";
// The config layer, and entrypoints that read env and pass it to `loadConfig`.
const ALLOWED = [
  /^packages\/junior\/src\/config\.ts$/,
  /^packages\/junior\/src\/cli\//,
  /^packages\/junior\/src\/instrumentation\.ts$/,
  /^packages\/junior\/src\/nitro\.ts$/,
  /^packages\/junior\/src\/build\//,
  /^packages\/junior\/src\/env\/files\.ts$/,
];
const MESSAGE =
  "Read env only in src/config.ts, through loadConfig, or in an entrypoint (src/cli/**, src/instrumentation.ts, src/nitro.ts, src/build/**, src/env/files.ts). Add the value to the config schema and read it from the resolved config.";

// `process.env.X`, `process.env["X"]`, destructuring, and passing
// `process.env` whole each contain one `process.env` member expression.
const RULES = `id: process-env
language: TypeScript
rule:
  pattern: process.env`;

/** Say whether a repository path is junior source that this check counts. */
export function isCheckedFile(filePath) {
  return (
    filePath.startsWith(`${SOURCE}/`) &&
    !ALLOWED.some((pattern) => pattern.test(filePath))
  );
}

/**
 * Count `process.env` reads per file with the ast-grep TypeScript parser, so
 * comments and strings are not counted. Paths in the result are relative to
 * `root`.
 */
export function countProcessEnvReads(root, targets) {
  const output = execFileSync(
    AST_GREP,
    ["scan", "--inline-rules", RULES, "--json=stream", ...targets],
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
 * Report files with more reads than the baseline allows, and baseline entries
 * that are now too high, so the baseline only gets smaller.
 */
export function checkProcessEnvReads(counts, baseline) {
  const errors = [];
  for (const [filePath, actual] of Object.entries(counts)) {
    const allowed = baseline[filePath] ?? 0;
    if (actual > allowed) {
      errors.push(
        `${filePath}: process.env reads: ${actual} found, baseline allows ${allowed}. ${MESSAGE}`,
      );
    }
  }
  for (const [filePath, allowed] of Object.entries(baseline)) {
    const actual = counts[filePath] ?? 0;
    if (actual < allowed) {
      errors.push(
        actual === 0
          ? `${filePath}: process.env reads: 0 found, baseline allows ${allowed}. Remove the entry from ${BASELINE_PATH}.`
          : `${filePath}: process.env reads: ${actual} found, baseline allows ${allowed}. Lower the entry in ${BASELINE_PATH} to ${actual}.`,
      );
    }
  }
  return errors;
}

/** Check that junior source reads `process.env` only in the config layer. */
export function run() {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  );
  const counts = Object.fromEntries(
    Object.entries(countProcessEnvReads(REPO_ROOT, [SOURCE])).filter(
      ([filePath]) => isCheckedFile(filePath),
    ),
  );
  const errors = checkProcessEnvReads(counts, baseline);
  if (errors.length === 0) return [];
  return [
    ...errors,
    `Fix the code. Do not hide the read in a helper, and do not add or raise entries in ${BASELINE_PATH}, to pass. When you move a file, move its entry.`,
  ];
}
