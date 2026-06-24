#!/usr/bin/env node
import { runPublicApiDocsCheck } from "./lib/checks/public-api-docs.mjs";

const checks = [
  {
    name: "public-api-docs",
    run: runPublicApiDocsCheck,
  },
];

let failed = false;

for (const check of checks) {
  const result = check.run();

  if (result.ok) {
    console.log(`${check.name}: OK - ${result.summary}`);
    continue;
  }

  failed = true;
  console.error(`${check.name}: failed`);

  for (const detail of result.details ?? []) {
    console.error(`  ${detail}`);
  }
}

if (failed) {
  process.exit(1);
}
