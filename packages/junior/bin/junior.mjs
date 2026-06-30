#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function loadCliFunction(moduleName, exportName, unavailableMessage) {
  const currentFile = fileURLToPath(import.meta.url);
  const modulePath = path.join(
    path.dirname(currentFile),
    "..",
    "dist",
    "cli",
    `${moduleName}.js`,
  );
  const moduleUrl = pathToFileURL(modulePath).href;
  const loadedModule = await import(moduleUrl);
  if (typeof loadedModule[exportName] !== "function") {
    throw new Error(unavailableMessage);
  }
  return loadedModule[exportName];
}

async function main() {
  const runMain = await loadCliFunction(
    "main",
    "runMain",
    "CLI dispatcher module is unavailable; reinstall @sentry/junior and retry.",
  );
  await runMain(process.argv.slice(2), { instrument: false });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`junior command failed: ${message}`);
  process.exit(1);
});
