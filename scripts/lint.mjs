import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pLimit from "p-limit";

/**
 * `pnpm lint`: run every lint step and fail when one fails.
 *
 * Type-aware oxlint takes the longest and uses every core, so it starts
 * first and the other steps run next to it, `OTHER_STEPS_AT_ONCE` at a time.
 * Each step runs its package.json script through `sh` with the package bins
 * on `PATH`, like `pnpm run` does, without the second of pnpm startup per
 * step. A step's output prints only when the step fails.
 *
 * oxlint runs its type-aware rules in tsgolint, a Go process. Go collects
 * garbage only when the heap doubles, so tsgolint grows past 5 GB on this
 * repo and an 8 GB machine runs out of memory. A soft limit at half the
 * machine's memory makes it collect sooner. `GOMEMLIMIT` in the environment
 * wins.
 *
 * `--changed`, which the pre-push hook passes, lints only what differs from
 * the merge base with origin/main. oxlint lints the changed files, unless a
 * change to its config, a tsconfig, or a package.json can change what it
 * reports in any file. A step with `when` runs only when a changed file
 * matches it. CI runs the full lint, which catches a type change that breaks
 * an unchanged file.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OTHER_STEPS_AT_ONCE = 2;
const GOMEMLIMIT = `${Math.floor(os.totalmem() / 2 / 2 ** 20)}MiB`;

const OXLINT = { dir: ".", command: "oxlint" };
const OXLINT_FILE = /\.[cm]?[jt]sx?$/;
// A change to one of these can change what oxlint reports in any file.
const OXLINT_CONFIG =
  /(?:^|\/)(?:\.oxlintrc\.json|tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml)$|^(?:tools\/oxlint|packages\/junior-dashboard\/oxlint)\//;
const changedIn =
  (...prefixes) =>
  (file) =>
    prefixes.some((prefix) => file.startsWith(prefix));
// Longest first, so a long step does not start last.
const OTHER_STEPS = [
  { dir: ".", command: "node scripts/check.mjs" },
  {
    dir: "packages/junior",
    script: "deps:check",
    when: changedIn("packages/junior/"),
  },
  { dir: ".", script: "ast-grep:lint" },
  {
    dir: ".",
    script: "package:lint",
    when: (file) =>
      /(?:^|\/)package\.json$/.test(file) ||
      file === "scripts/package-lint.mjs",
  },
  ...[
    "tool-annotations:check",
    "tool-descriptions:check",
    "tool-key-casing:check",
    "tool-error-classification:check",
  ].map((script) => ({
    dir: "packages/junior",
    script,
    when: changedIn("packages/"),
  })),
  {
    dir: ".",
    script: "oxlint-rules:check",
    when: changedIn("tools/oxlint/", "packages/junior-dashboard/oxlint/"),
  },
  {
    dir: ".",
    script: "verify-junior:check",
    when: changedIn(".agents/skills/verify-junior/"),
  },
];

/**
 * Return the files that differ from the merge base with origin/main,
 * deleted files included, or `undefined` when git cannot find that base,
 * such as in a shallow clone.
 */
function changedFiles() {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  let base;
  try {
    base = git("merge-base", "HEAD", "origin/main").trim();
  } catch {
    return undefined;
  }
  return git("diff", "--name-only", "-z", base).split("\0").filter(Boolean);
}

/** Return the oxlint step for the changed files, or `undefined` for none. */
function oxlintStep(changed) {
  if (!changed || changed.some((file) => OXLINT_CONFIG.test(file))) {
    return OXLINT;
  }
  const files = changed.filter(
    (file) => OXLINT_FILE.test(file) && fs.existsSync(path.join(ROOT, file)),
  );
  if (files.length === 0) return undefined;
  // An ignored file, such as an eval fixture, can be the only change.
  return { ...OXLINT, args: ["--no-error-on-unmatched-pattern", ...files] };
}

function commandOf({ dir, script, command }) {
  if (command) return command;
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, dir, "package.json"), "utf8"),
  );
  const text = packageJson.scripts?.[script];
  if (!text) throw new Error(`${dir}/package.json has no "${script}" script`);
  return text;
}

function runStep(step) {
  const cwd = path.join(ROOT, step.dir);
  const name = step.script ?? step.command;
  const started = performance.now();
  return new Promise((resolve) => {
    const output = [];
    const finish = (ok, note) => {
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      console.log(`${ok ? "PASS" : "FAIL"} ${name} (${seconds}s)`);
      if (!ok) process.stdout.write(Buffer.concat(output));
      if (note) console.log(note);
      resolve(ok);
    };
    // `"$@"` passes the step's args to the command without shell quoting.
    const args = ["-c", `${commandOf(step)} "$@"`, "sh", ...(step.args ?? [])];
    const child = spawn("sh", args, {
      cwd,
      env: {
        GOMEMLIMIT,
        ...process.env,
        PATH: [
          path.join(cwd, "node_modules/.bin"),
          path.join(ROOT, "node_modules/.bin"),
          process.env.PATH,
        ].join(path.delimiter),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    // A spawn error still ends in "close", which reports the step.
    child.on("error", (error) => output.push(Buffer.from(`${error}\n`)));
    child.on("close", (code, signal) =>
      finish(code === 0, signal ? `${name} stopped on ${signal}.` : undefined),
    );
  });
}

const scoped = process.argv.includes("--changed");
const changed = scoped ? changedFiles() : undefined;
if (scoped && !changed) {
  console.log("No merge base with origin/main, so every step lints the repo.");
}
const oxlint = oxlintStep(changed);
const otherSteps = OTHER_STEPS.filter(
  (step) => !changed || !step.when || changed.some(step.when),
);
const limit = pLimit(OTHER_STEPS_AT_ONCE);
const results = await Promise.all([
  ...(oxlint ? [runStep(oxlint)] : []),
  ...otherSteps.map((step) => limit(() => runStep(step))),
]);
process.exitCode = results.every(Boolean) ? 0 : 1;
