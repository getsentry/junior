import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Unused code ratchet. Knip finds files that nothing imports and exports that
 * no other file imports. `knip.json` names the entry files: package exports,
 * scripts, tests, and evals, so public package API is never reported. The
 * baseline lists the unused code that existed when this check was added. A
 * new finding fails, and a fixed finding must leave the baseline.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const KNIP = path.join(REPO_ROOT, "node_modules/.bin/knip");
const BASELINE_PATH = "scripts/unused-code-baseline.json";
const ISSUE_TYPES = ["files", "exports", "types"];
const MESSAGE = {
  files: "unused file. Delete it.",
  exports:
    "unused export. Delete it, or drop `export` when only this file uses it.",
  types:
    "unused exported type. Delete it, or drop `export` when only this file uses it.",
};

function runKnip(root) {
  const output = execFileSync(
    KNIP,
    [
      "--include",
      ISSUE_TYPES.join(","),
      "--reporter",
      "json",
      "--no-progress",
      "--no-exit-code",
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(output);
}

/**
 * Collect knip findings as sorted `{ files, exports, types }` lists. An unused
 * file is a path. An unused export or type is `path: name`.
 */
export function collectFindings(report) {
  const findings = { files: [], exports: [], types: [] };
  for (const issue of report.issues) {
    if (issue.files.length > 0) findings.files.push(issue.file);
    for (const type of ["exports", "types"]) {
      for (const { name } of issue[type]) {
        findings[type].push(`${issue.file}: ${name}`);
      }
    }
  }
  for (const type of ISSUE_TYPES) findings[type].sort();
  return findings;
}

/**
 * Report findings that the baseline does not list, and baseline entries that
 * knip no longer finds, so the baseline only gets smaller.
 */
export function checkUnusedCode(findings, baseline) {
  const errors = [];
  for (const type of ISSUE_TYPES) {
    const found = new Set(findings[type]);
    const allowed = new Set(baseline[type] ?? []);
    for (const entry of found) {
      if (!allowed.has(entry)) errors.push(`${entry}: ${MESSAGE[type]}`);
    }
    for (const entry of allowed) {
      if (!found.has(entry)) {
        errors.push(
          `${entry}: no longer unused. Remove it from "${type}" in ${BASELINE_PATH}.`,
        );
      }
    }
  }
  return errors;
}

function main() {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  );
  const errors = checkUnusedCode(collectFindings(runKnip(REPO_ROOT)), baseline);
  if (errors.length === 0) {
    console.log("No new unused files or exports.");
    return;
  }
  console.error(
    [
      "Unused code check failed:",
      ...errors,
      `Do not add entries to ${BASELINE_PATH} to pass. When a script, test, or package export loads a file that knip cannot see, add it as an entry in knip.json.`,
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
