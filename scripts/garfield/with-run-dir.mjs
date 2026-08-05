#!/usr/bin/env node
/**
 * Resolve the active Garfield run directory and exec a command against it.
 *
 * Usage:
 *   node scripts/garfield/with-run-dir.mjs <script.mjs> [script args...]
 *
 * Looks up `.swamp/garfield/last-run.json` written by capture-run-dir.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "./lib.mjs";

const repoRoot = resolveRepoRoot(process.cwd());
const pointerPath = path.join(repoRoot, ".swamp", "garfield", "last-run.json");
if (!fs.existsSync(pointerPath)) {
  console.error(`Missing run pointer: ${pointerPath}`);
  process.exit(1);
}

const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
if (!pointer.runDir) {
  console.error(`Run pointer missing runDir: ${pointerPath}`);
  process.exit(1);
}

const [scriptName, ...rest] = process.argv.slice(2);
if (!scriptName) {
  console.error(
    "Usage: node scripts/garfield/with-run-dir.mjs <script.mjs> [args...]",
  );
  process.exit(1);
}

const scriptPath = path.isAbsolute(scriptName)
  ? scriptName
  : path.join(path.dirname(fileURLToPath(import.meta.url)), scriptName);

const result = spawnSync(
  process.execPath,
  [scriptPath, "--run-dir", pointer.runDir, ...rest],
  {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  },
);

process.exit(result.status ?? 1);
