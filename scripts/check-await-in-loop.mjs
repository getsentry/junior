import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `no-await-in-loop` ratchet for package source. The rule is on for
 * `packages/*\/src`, and `tools/oxlint/await-in-loop.json` turns it off for the
 * files that had sites when the rule was added. The baseline holds the
 * per-file count of those sites. A count can only go down, so a listed file
 * cannot add a site that oxlint does not report.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const OXLINT = path.join(REPO_ROOT, "node_modules/.bin/oxlint");
const BASELINE_PATH = "scripts/await-in-loop-baseline.json";
const OVERRIDE_PATH = "tools/oxlint/await-in-loop.json";
const RULE = "no-await-in-loop";
const MESSAGE =
  "Start independent work together with Promise.all, through a p-limit limiter for a list. Keep an await in a loop only when each step needs the one before, and say why in an `oxlint-disable-next-line no-await-in-loop -- <reason>` comment. See policies/performance.md.";

/**
 * Count `no-await-in-loop` sites per file. Disable comments still apply. Paths
 * in the result are relative to `root`.
 */
export function countAwaitInLoop(root, targets) {
  if (targets.length === 0) return {};
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "await-in-loop-"));
  const config = path.join(directory, "oxlintrc.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      categories: { correctness: "off" },
      plugins: ["eslint"],
      rules: { [RULE]: "error" },
    }),
  );
  try {
    const output = runOxlint(root, [
      "--config",
      config,
      "--disable-nested-config",
      "--format",
      "json",
      ...targets,
    ]);
    const counts = {};
    for (const diagnostic of JSON.parse(output).diagnostics) {
      if (diagnostic.code !== `eslint(${RULE})`) continue;
      const file = diagnostic.filename.split(path.sep).join("/");
      counts[file] = (counts[file] ?? 0) + 1;
    }
    return counts;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runOxlint(root, args) {
  try {
    return execFileSync(OXLINT, args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    // oxlint exits 1 when it reports a site. The JSON is still on stdout.
    if (error.status === 1 && error.stdout) return error.stdout;
    throw error;
  }
}

/**
 * Report baseline counts that grew or shrank, and override files that do not
 * match the baseline, so the baseline only gets smaller.
 */
export function checkAwaitInLoop({ baseline, counts, overrideFiles }) {
  const errors = [];
  for (const [filePath, allowed] of Object.entries(baseline)) {
    const actual = counts[filePath] ?? 0;
    if (actual > allowed) {
      errors.push(
        `${filePath}: ${RULE}: ${actual} found, baseline allows ${allowed}. ${MESSAGE}`,
      );
    } else if (actual < allowed) {
      errors.push(
        actual === 0
          ? `${filePath}: ${RULE}: 0 found, baseline allows ${allowed}. Remove the entry from ${BASELINE_PATH} and from ${OVERRIDE_PATH}.`
          : `${filePath}: ${RULE}: ${actual} found, baseline allows ${allowed}. Lower the entry in ${BASELINE_PATH} to ${actual}.`,
      );
    }
  }
  const listed = new Set(overrideFiles);
  for (const filePath of Object.keys(baseline)) {
    if (!listed.has(filePath)) {
      errors.push(
        `${filePath}: in ${BASELINE_PATH} but not in ${OVERRIDE_PATH}.`,
      );
    }
  }
  for (const filePath of listed) {
    if (!(filePath in baseline)) {
      errors.push(
        `${filePath}: in ${OVERRIDE_PATH} but not in ${BASELINE_PATH}. Do not add files to the baseline.`,
      );
    }
  }
  return errors;
}

/** Read the files that the override config exempts from the rule. */
export function readOverrideFiles(config) {
  return config.overrides
    .filter((override) => override.rules?.[RULE] === "off")
    .flatMap((override) => override.files);
}

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
  );
}

function main() {
  const baseline = readJson(BASELINE_PATH);
  const errors = checkAwaitInLoop({
    baseline,
    // A moved or deleted file counts 0, so its entry must go.
    counts: countAwaitInLoop(
      REPO_ROOT,
      Object.keys(baseline).filter((filePath) =>
        fs.existsSync(path.join(REPO_ROOT, filePath)),
      ),
    ),
    overrideFiles: readOverrideFiles(readJson(OVERRIDE_PATH)),
  });
  if (errors.length === 0) {
    console.log("The await-in-loop baseline matches the code.");
    return;
  }
  console.error(
    [
      "await-in-loop check failed:",
      ...errors,
      `Fix the code. Do not add or raise entries in ${BASELINE_PATH} to pass. When you move a file, move its entry in both files.`,
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
