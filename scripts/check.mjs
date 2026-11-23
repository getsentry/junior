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
import pLimit from "p-limit";
import { listRepoFiles } from "./lib/repo-files.mjs";

/**
 * Run repo checks by name: `node scripts/check.mjs file-length money-units`.
 * Each `scripts/check-<name>.mjs` is a check. With no name, the runner runs
 * every check except the ones whose module exports `lint = false`.
 *
 * The runner lists the repo files once and runs each check in a worker
 * thread, in parallel. A worker first runs the check's
 * `scripts/check-<name>.test.mjs` tests, if any. Then it calls the exported
 * `run({ root, files, args })`, which returns the problems it finds. `files`
 * comes from `lib/repo-files.mjs`, so a check filters it instead of walking
 * the repo. Flags, such as `--update`, are `args`. Each `pnpm <name>:check`
 * script calls this runner.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");

/** Return the check names, from the `scripts/check-<name>.mjs` files. */
function checkNames() {
  return fs
    .readdirSync(SCRIPTS)
    .map((file) => /^check-(.+)\.mjs$/.exec(file)?.[1])
    .filter((name) => name && !name.endsWith(".test"))
    .sort();
}

/**
 * Run one check in a worker thread. Resolve to the problems it finds, or to
 * `undefined` when `lintOnly` is set and the check is not part of lint.
 */
function runInWorker(name, lintOnly, context) {
  return new Promise((resolve) => {
    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { name, lintOnly, context },
    });
    worker.once("message", resolve);
    worker.once("error", (error) => resolve([error.stack ?? String(error)]));
    worker.once("exit", (code) =>
      resolve(code === 0 ? [] : [`The check exited with code ${code}.`]),
    );
  });
}

async function main(names, args) {
  const known = checkNames();
  const unknown = names.filter((name) => !known.includes(name));
  if (unknown.length > 0) {
    console.error(
      `Unknown check: ${unknown.join(", ")}. Known: ${known.join(", ")}`,
    );
    return 1;
  }
  const lintOnly = names.length === 0;
  const selected = lintOnly ? known : names;
  const context = { root: ROOT, files: listRepoFiles(ROOT), args };
  const results = await pLimit(os.availableParallelism()).map(
    selected,
    (name) => runInWorker(name, lintOnly, context),
  );
  let failed = false;
  for (const [index, name] of selected.entries()) {
    const errors = results[index];
    if (errors === undefined) continue;
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

/** Run the check's tests, then the check, inside a worker thread. */
async function runCheck({ name, lintOnly, context }) {
  const check = await import(`./check-${name}.mjs`);
  if (lintOnly && check.lint === false) return undefined;
  const test = path.join(SCRIPTS, `check-${name}.test.mjs`);
  if (fs.existsSync(test)) {
    const result = spawnSync(process.execPath, ["--test", test], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      return `${result.stdout}${result.stderr}`.trim().split("\n");
    }
  }
  return check.run(context);
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
  parentPort.postMessage(await runCheck(workerData));
}
