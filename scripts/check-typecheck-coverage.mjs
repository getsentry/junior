#!/usr/bin/env node
// Fails when a tracked TypeScript file is in no project that a check runs.
// A project counts only when `pnpm typecheck` or `astro check` runs it, and
// only when it does not set `noCheck`. Every other tsconfig.json fails.
// `tsc --showConfig` lists the files of a project without a type check, so
// this runs fast.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const tsc = path.join(root, "node_modules/.bin/tsc");
const BASELINE_PATH = "scripts/typecheck-coverage-baseline.json";

// Files that are not repository code. Give the reason for each entry.
const EXCLUDED = [
  // Project files that coding evals copy into a sandbox. They are eval
  // inputs, not repository code.
  "packages/junior-evals/fixtures/",
  // Compiled against the packed release tarballs, not the workspace, by
  // scripts/release-artifacts.mjs.
  "scripts/release-consumer/",
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

/** Project directories that the root typecheck and the docs check run. */
function runProjects() {
  const projects = new Set();
  const errors = [];
  const rootScript = readJson("package.json").scripts?.typecheck ?? "";
  const [first, ...rest] = rootScript.split(" && ");
  if (first !== "pnpm -r run typecheck") {
    errors.push(`Unknown root typecheck script: ${rootScript}`);
  }
  for (const command of rest) {
    const project = /^tsc --noEmit -p (\S+)$/.exec(command)?.[1];
    if (project) projects.add(project);
    else errors.push(`Unknown root typecheck command: ${command}`);
  }
  // The workspace packages, as pnpm-workspace.yaml lists them.
  const directories = ["apps", "packages"].flatMap((group) =>
    fs.readdirSync(path.join(root, group)).map((name) => `${group}/${name}`),
  );
  for (const directory of directories) {
    const manifest = `${directory}/package.json`;
    if (!fs.existsSync(path.join(root, manifest))) continue;
    const scripts = readJson(manifest).scripts ?? {};
    if (scripts.typecheck === "tsc --noEmit") {
      projects.add(directory);
    } else if (scripts.typecheck !== undefined) {
      errors.push(`Unknown typecheck script in ${manifest}`);
    } else if (scripts.check?.startsWith("astro check")) {
      projects.add(directory);
    }
  }
  return { projects, errors };
}

const { projects, errors } = runProjects();
const discovered = git("*tsconfig.json")
  .filter((file) => !EXCLUDED.some((prefix) => file.startsWith(prefix)))
  .map((file) => path.dirname(file));
for (const project of discovered) {
  if (!projects.has(project)) {
    errors.push(`No check runs this project: ${project}/tsconfig.json`);
  }
}
for (const project of projects) {
  if (!discovered.includes(project)) {
    errors.push(`A check runs a missing project: ${project}`);
  }
}

const checked = new Set();
for (const project of projects) {
  if (!discovered.includes(project)) continue;
  const config = JSON.parse(
    execFileSync(tsc, ["--showConfig", "-p", project], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  if (config.compilerOptions?.noCheck === true) {
    errors.push(`Project sets noCheck, so it checks nothing: ${project}`);
    continue;
  }
  for (const file of config.files ?? []) {
    checked.add(path.relative(root, path.resolve(root, project, file)));
  }
}

// Files with type errors that no project checks yet. The list only shrinks:
// a new unchecked file fails, and so does an entry that a project checks now.
const baseline = new Set(readJson(BASELINE_PATH));
const unchecked = git("*.ts", "*.tsx", "*.mts", "*.cts").filter(
  (file) =>
    !file.endsWith(".d.ts") &&
    !checked.has(file) &&
    !EXCLUDED.some((prefix) => file.startsWith(prefix)),
);
for (const file of unchecked) {
  if (!baseline.delete(file)) {
    errors.push(`Not in a type-check project: ${file}`);
  }
}
for (const file of baseline) {
  errors.push(`Remove from ${BASELINE_PATH}, it is checked or gone: ${file}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log(
  `Type-check coverage OK: ${checked.size} files in ${projects.size} projects.`,
);
