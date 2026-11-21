import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { listRepoFiles } from "./lib/repo-files.mjs";

/**
 * Run repo checks by name: `node scripts/check.mjs file-length money-units`.
 * With no name, it runs every check that `pnpm lint` needs. The runner first
 * runs the `scripts/check-<file>.test.mjs` tests of the checks. Then it lists
 * the repo files once and runs each check in a worker thread, in parallel.
 * Each `scripts/check-<file>.mjs` exports `run({ root, files, args })`, which
 * returns the problems it finds. `files` comes from `lib/repo-files.mjs`, so a
 * check filters it instead of walking the repo. Flags, such as `--update`, are
 * `args`. Each `pnpm <name>:check` script calls this runner.
 */

// `lint: true` checks run when no name is given.
const CHECKS = {
  "file-length": { file: "file-length", lint: true },
  "baseline-growth": { file: "baseline-growth", lint: true },
  "typecheck-coverage": { file: "typecheck-coverage", lint: true },
  "migration-metadata": { file: "drizzle-migrations", lint: true },
  "migration-locks": { file: "migration-locks", lint: true },
  "money-units": { file: "money-units", lint: true },
  "lockfile-families": { file: "lockfile-families", lint: true },
  "test-architecture": { file: "test-architecture", lint: true },
  "type-assertions": { file: "type-assertions", lint: true },
  "await-in-loop": { file: "await-in-loop", lint: true },
  "nav-request-budgets": { file: "nav-request-budgets", lint: true },
  "dashboard-style": { file: "dashboard-styles", lint: true },
  // `ast-grep:lint` runs this after the ast-grep scan.
  "ast-grep-ignores": { file: "ast-grep-ignores", lint: false },
  // CI runs these in their own jobs, after a build or on release changes.
  "dashboard-bundle-size": { file: "dashboard-bundle-size", lint: false },
  "package-types": { file: "package-types", lint: false },
  release: { file: "release-config", lint: false },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Return the check script files in `scripts/` that have no runner entry. */
function unregisteredScripts() {
  const registered = new Set(
    Object.values(CHECKS).map((check) => `check-${check.file}.mjs`),
  );
  return fs
    .readdirSync(path.join(ROOT, "scripts"))
    .filter(
      (name) =>
        /^check-.+\.mjs$/.test(name) &&
        !name.endsWith(".test.mjs") &&
        !registered.has(name),
    );
}

/** Run one check in a worker thread and resolve to the problems it finds. */
function runInWorker(file, context) {
  return new Promise((resolve) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { file, context },
    });
    worker.once("message", resolve);
    worker.once("error", (error) => resolve([error.stack ?? String(error)]));
    worker.once("exit", (code) =>
      resolve(code === 0 ? [] : [`The check exited with code ${code}.`]),
    );
  });
}

/** Run `task` on each item, at most `limit` at a time, and keep the order. */
async function mapBounded(items, limit, task) {
  const results = [];
  let next = 0;
  async function drain() {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, drain),
  );
  return results;
}

async function main(names, args) {
  const unregistered = unregisteredScripts();
  if (unregistered.length > 0) {
    console.error(
      `Add each check script to CHECKS in scripts/check.mjs: ${unregistered.join(", ")}`,
    );
    return 1;
  }
  const unknown = names.filter((name) => !(name in CHECKS));
  if (unknown.length > 0) {
    console.error(
      `Unknown check: ${unknown.join(", ")}. Known: ${Object.keys(CHECKS).join(", ")}`,
    );
    return 1;
  }
  const selected =
    names.length > 0
      ? names
      : Object.keys(CHECKS).filter((name) => CHECKS[name].lint);

  const tests = selected
    .map((name) => `scripts/check-${CHECKS[name].file}.test.mjs`)
    .filter((test) => fs.existsSync(path.join(ROOT, test)));
  if (tests.length > 0) {
    const result = spawnSync(process.execPath, ["--test", ...tests], {
      cwd: ROOT,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }

  const context = { root: ROOT, files: listRepoFiles(ROOT), args };
  const results = await mapBounded(
    selected,
    os.availableParallelism(),
    (name) => runInWorker(CHECKS[name].file, context),
  );
  let failed = false;
  for (const [index, name] of selected.entries()) {
    const errors = results[index];
    if (errors.length === 0) {
      console.log(`PASS ${name}`);
      continue;
    }
    failed = true;
    console.error(
      [`FAIL ${name}`, ...errors.map((error) => `  ${error}`)].join("\n"),
    );
  }
  return failed ? 1 : 0;
}

if (isMainThread) {
  // lint-staged appends the staged file paths. The checks scan the whole repo,
  // so the runner ignores them.
  const argv = process.argv.slice(2).filter((arg) => !arg.includes(path.sep));
  process.exitCode = await main(
    argv.filter((arg) => !arg.startsWith("-")),
    argv.filter((arg) => arg.startsWith("-")),
  );
} else {
  const { file, context } = workerData;
  const { run } = await import(`./check-${file}.mjs`);
  parentPort.postMessage(await run(context));
}
