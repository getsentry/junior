#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const newVersion = process.argv[2];
if (!newVersion) {
  console.error("Usage: node scripts/bump-release-versions.mjs <new-version>");
  process.exit(1);
}

const files = [
  "packages/junior/package.json",
  "packages/junior-agent-browser/package.json",
  "packages/junior-datadog/package.json",
  "packages/junior-github/package.json",
  "packages/junior-linear/package.json",
  "packages/junior-notion/package.json",
  "packages/junior-sentry/package.json",
];

for (const relativePath of files) {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  const pkg = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  pkg.version = newVersion;
  fs.writeFileSync(absolutePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

console.log(`Updated ${files.length} package versions to ${newVersion}`);
