#!/usr/bin/env node
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArgs,
  readJson,
  resolveRepoRoot,
  writeJson,
} from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(
    "Usage: node scripts/garfield/validate.mjs --run-dir <path> [--only-required]",
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (typeof args["run-dir"] !== "string") usage(1);

const runDir = path.resolve(args["run-dir"]);
const bundle = readJson(path.join(runDir, "bundle.json"));
const repoRoot = resolveRepoRoot(bundle.repoRoot || process.cwd());
const onlyRequired = Boolean(args["only-required"]);

const commands = onlyRequired
  ? bundle.validationCommands.filter((item) => item.required)
  : bundle.validationCommands;

const results = [];
for (const item of commands) {
  const started = Date.now();
  const result = spawnSync(item.command, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  results.push({
    id: item.id,
    command: item.command,
    required: Boolean(item.required),
    ok: result.status === 0,
    status: result.status,
    durationMs: Date.now() - started,
    stdout: (result.stdout || "").slice(0, 4000),
    stderr: (result.stderr || "").slice(0, 4000),
  });
}

writeJson(path.join(runDir, "validation.json"), {
  runId: bundle.runId,
  results,
});

const failedRequired = results.filter((item) => item.required && !item.ok);
console.log(
  JSON.stringify(
    {
      ok: failedRequired.length === 0,
      runId: bundle.runId,
      ran: results.length,
      failedRequired: failedRequired.map((item) => item.id),
      results: results.map((item) => ({
        id: item.id,
        ok: item.ok,
        command: item.command,
      })),
      validationPath: path.join(runDir, "validation.json"),
    },
    null,
    2,
  ),
);

if (failedRequired.length > 0) {
  process.exitCode = 1;
}
