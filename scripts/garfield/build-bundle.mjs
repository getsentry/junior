#!/usr/bin/env node
import path from "node:path";
import {
  buildBundle,
  createRunId,
  defaultRunDir,
  ensureDir,
  parseArgs,
  resolveRepoRoot,
  writeJson,
} from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(`Usage: node scripts/garfield/build-bundle.mjs --goal <text> [options]

Options:
  --goal <text>          Required slice goal / user intent
  --non-goal <text>      Repeatable non-goal
  --base <ref>           Diff base (default: merge-base with origin/main)
  --run-id <id>          Stable run id (default: generated)
  --run-dir <path>       Output directory (default: .swamp/garfield/<run-id>)
  --repo-root <path>     Repo root (default: discover from cwd)
`);
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (!args.goal || args.goal === true) usage(1);

const repoRoot = resolveRepoRoot(
  typeof args["repo-root"] === "string" && args["repo-root"]
    ? args["repo-root"]
    : process.cwd(),
);
const nonGoals = []
  .concat(args["non-goal"] ?? [])
  .concat(args["non-goals"] ?? [])
  .flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      return value.includes(",")
        ? value.split(",").map((part) => part.trim())
        : [value];
    }
    return [];
  })
  .filter((value) => typeof value === "string" && value.length > 0);

const runId =
  typeof args["run-id"] === "string" && args["run-id"]
    ? args["run-id"]
    : createRunId();
const runDir =
  typeof args["run-dir"] === "string" && args["run-dir"]
    ? path.resolve(args["run-dir"])
    : defaultRunDir(repoRoot, runId);

ensureDir(runDir);

const bundle = buildBundle({
  repoRoot,
  goal: String(args.goal),
  nonGoals,
  baseRef:
    typeof args.base === "string" && args.base ? args.base : undefined,
  runId,
});

const bundlePath = path.join(runDir, "bundle.json");
writeJson(bundlePath, bundle);
writeJson(path.join(runDir, "run.json"), {
  runId,
  runDir,
  bundlePath,
  createdAt: bundle.createdAt,
});

console.log(
  JSON.stringify(
    {
      ok: true,
      runId,
      runDir,
      bundlePath,
      changedFiles: bundle.changedFiles.length,
      packages: bundle.packages,
      contentHash: bundle.contentHash,
    },
    null,
    2,
  ),
);
