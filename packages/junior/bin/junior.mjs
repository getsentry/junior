#!/usr/bin/env node

import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const { positionals } = parseArgs({
  allowPositionals: true,
  strict: false
});

const command = positionals[0];
const subcommand = positionals[1];

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

async function main() {
  if (command === "init") {
    const dir = positionals[1];
    if (!dir) {
      console.error("usage: junior init <dir>");
      process.exit(1);
    }
    await runInit(dir);
    return;
  }

  if (command === "snapshot" && subcommand === "create") {
    await runSnapshotCreate();
    return;
  }

  console.error("usage: junior init <dir>\n       junior snapshot create");
  process.exit(1);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior command failed: ${message}`);
  process.exit(1);
});
