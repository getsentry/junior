#!/usr/bin/env node

import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { positionals } = parseArgs({
  allowPositionals: true,
  strict: false
});

const command = positionals[0];

async function loadCliFunction(moduleName, exportName, unavailableMessage) {
  const currentFile = fileURLToPath(import.meta.url);
  const modulePath = path.join(path.dirname(currentFile), "..", "dist", "cli", `${moduleName}.js`);
  const moduleUrl = pathToFileURL(modulePath).href;
  const loadedModule = await import(moduleUrl);
  if (typeof loadedModule[exportName] !== "function") {
    throw new Error(unavailableMessage);
  }
  return loadedModule[exportName];
}

async function runSnapshotCreate() {
  const runSnapshotCreateFn = await loadCliFunction(
    "snapshot-warmup",
    "runSnapshotCreate",
    "Snapshot create module is unavailable; reinstall @sentry/junior and retry."
  );
  await runSnapshotCreateFn();
}

async function runInit(dir) {
  const runInitFn = await loadCliFunction("init", "runInit", "Init module is unavailable; reinstall @sentry/junior and retry.");
  await runInitFn(dir);
}

async function runCheck(dir) {
  const runCheckFn = await loadCliFunction(
    "check",
    "runCheck",
    "Check module is unavailable; reinstall @sentry/junior and retry."
  );
  await runCheckFn(dir);
}

async function main() {
  const runCli = await loadCliFunction(
    "run",
    "runCli",
    "CLI dispatcher module is unavailable; reinstall @sentry/junior and retry."
  );
  const exitCode = await runCli(positionals, {
    runInit,
    runSnapshotCreate,
    runCheck
  });
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior command failed: ${message}`);
  process.exit(1);
});
