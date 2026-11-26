import { spawn } from "node:child_process";
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
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OTHER_STEPS_AT_ONCE = 2;
const GOMEMLIMIT = `${Math.floor(os.totalmem() / 2 / 2 ** 20)}MiB`;

const OXLINT = { dir: ".", command: "oxlint" };
// Longest first, so a long step does not start last.
const OTHER_STEPS = [
  { dir: ".", command: "node scripts/check.mjs" },
  { dir: "packages/junior", script: "deps:check" },
  { dir: ".", script: "ast-grep:lint" },
  { dir: ".", script: "package:lint" },
  { dir: "packages/junior", script: "tool-annotations:check" },
  { dir: "packages/junior", script: "tool-descriptions:check" },
  { dir: "packages/junior", script: "tool-key-casing:check" },
  { dir: "packages/junior", script: "tool-error-classification:check" },
  { dir: ".", script: "oxlint-rules:check" },
];

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
    const child = spawn("sh", ["-c", commandOf(step)], {
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

const limit = pLimit(OTHER_STEPS_AT_ONCE);
const results = await Promise.all([
  runStep(OXLINT),
  ...OTHER_STEPS.map((step) => limit(() => runStep(step))),
]);
process.exitCode = results.every(Boolean) ? 0 : 1;
