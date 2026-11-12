#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let cliModule;

async function loadCliModule(moduleName) {
  const currentFile = fileURLToPath(import.meta.url);
  const modulePath = path.join(
    path.dirname(currentFile),
    "..",
    "dist",
    "cli",
    `${moduleName}.js`,
  );
  return await import(pathToFileURL(modulePath).href);
}

async function main() {
  cliModule = await loadCliModule("main");
  if (typeof cliModule.runMain !== "function") {
    throw new Error(
      "CLI dispatcher module is unavailable; reinstall @sentry/junior and retry.",
    );
  }
  await cliModule.runMain(process.argv.slice(2), { instrument: false });
}

function failureMessage(error) {
  if (typeof cliModule?.formatCliFailure === "function") {
    return cliModule.formatCliFailure(error);
  }
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(`junior command failed: ${failureMessage(error)}`);
  process.exit(1);
});
