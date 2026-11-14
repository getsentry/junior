#!/usr/bin/env node
// Fails when a tracked TypeScript file is in no type-check project. Each
// tsconfig.json (except build-only configs) is a project. `tsc --showConfig`
// lists the files of a project without a type check, so this runs fast.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const tsc = path.join(root, "node_modules/.bin/tsc");

// Files that no project checks yet. Keep each entry narrow and give the
// reason and the removal condition.
const UNCHECKED = [
  // Plugin tests: about 370 type errors (mostly stale fakes and unchecked
  // index access). Remove an entry when its tests pass in the package project.
  "packages/junior-github/tests/",
  "packages/junior-google/tests/",
  "packages/junior-linear/tests/",
  "packages/junior-memory/tests/",
  "packages/junior-sentry/tests/",
  "packages/junior-vercel/tests/",
  // Playwright specs: about 40 type errors. Remove when the dashboard
  // project includes e2e/ and passes.
  "packages/junior-dashboard/e2e/",
  // Project files that coding evals copy into a sandbox. They are eval
  // inputs, not repository code.
  "packages/junior-evals/fixtures/",
];

// Tracked and new files that still exist in the working tree.
function git(...patterns) {
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", ...patterns],
    { cwd: root, encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => file && fs.existsSync(path.join(root, file)));
}

const projects = git("*tsconfig.json").map((file) => path.dirname(file));

const checked = new Set();
for (const project of projects) {
  const output = execFileSync(tsc, ["--showConfig", "-p", project], {
    cwd: root,
    encoding: "utf8",
  });
  for (const file of JSON.parse(output).files ?? []) {
    checked.add(path.relative(root, path.resolve(root, project, file)));
  }
}

const unchecked = git("*.ts", "*.tsx", "*.mts", "*.cts").filter(
  (file) =>
    !file.endsWith(".d.ts") &&
    !checked.has(file) &&
    !UNCHECKED.some((prefix) => file.startsWith(prefix)),
);

const staleEntries = UNCHECKED.filter((prefix) =>
  [...checked].some((file) => file.startsWith(prefix)),
);

if (unchecked.length > 0 || staleEntries.length > 0) {
  for (const file of unchecked) {
    console.error(`Not in a type-check project: ${file}`);
  }
  for (const prefix of staleEntries) {
    console.error(`Remove from UNCHECKED, a project checks it now: ${prefix}`);
  }
  process.exit(1);
}

console.log(
  `Type-check coverage OK: ${checked.size} files in ${projects.length} projects.`,
);
