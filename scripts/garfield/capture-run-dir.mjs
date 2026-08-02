#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ensureDir, parseArgs, resolveRepoRoot, writeJson } from "./lib.mjs";

function usage(exitCode = 1) {
  console.error(
    "Usage: node scripts/garfield/capture-run-dir.mjs --from <build-json-path>",
  );
  process.exit(exitCode);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) usage(0);
if (typeof args.from !== "string") usage(1);

const repoRoot = resolveRepoRoot(process.cwd());
const fromPath = path.resolve(args.from);
const built = JSON.parse(fs.readFileSync(fromPath, "utf8"));
if (!built.runDir || !built.runId) {
  console.error("build output missing runDir/runId", built);
  process.exit(1);
}

const pointerDir = path.join(repoRoot, ".swamp", "garfield");
ensureDir(pointerDir);
const pointerPath = path.join(pointerDir, "last-run.json");
writeJson(pointerPath, {
  ok: true,
  runId: built.runId,
  runDir: built.runDir,
  bundlePath: built.bundlePath,
  capturedAt: new Date().toISOString(),
});

console.log(
  JSON.stringify(
    {
      ok: true,
      runId: built.runId,
      runDir: built.runDir,
      pointerPath,
    },
    null,
    2,
  ),
);
