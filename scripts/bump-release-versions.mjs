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
  "packages/junior-plugin-api/package.json",
  "packages/junior-agent-browser/package.json",
  "packages/junior-amplitude/package.json",
  "packages/junior-cloudflare/package.json",
  "packages/junior-dashboard/package.json",
  "packages/junior-datadog/package.json",
  "packages/junior-figma/package.json",
  "packages/junior-tts/package.json",
  "packages/junior-github/package.json",
  "packages/junior-google/package.json",
  "packages/junior-hex/package.json",
  "packages/junior-linear/package.json",
  "packages/junior-notion/package.json",
  "packages/junior-octolens/package.json",
  "packages/junior-pagerduty/package.json",
  "packages/junior-restream/package.json",
  "packages/junior-maintenance/package.json",
  "packages/junior-sentry/package.json",
  "packages/junior-vercel/package.json",
  "packages/junior-xdotcom/package.json",
];

for (const relativePath of files) {
  const absolutePath = path.resolve(process.cwd(), relativePath);
  const pkg = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  pkg.version = newVersion;
  fs.writeFileSync(absolutePath, `${JSON.stringify(pkg, null, 2)}\n`);
}

// The iOS app ships the same version, so its changelog versions match.
const iosProject = path.resolve(process.cwd(), "apps/ios/project.yml");
const project = fs.readFileSync(iosProject, "utf8");
const marketingVersion = /^(\s*MARKETING_VERSION: )"[^"]*"$/m;
if (!marketingVersion.test(project)) {
  console.error("apps/ios/project.yml has no MARKETING_VERSION line");
  process.exit(1);
}
fs.writeFileSync(
  iosProject,
  project.replace(marketingVersion, `$1"${newVersion}"`),
);

console.log(
  `Updated ${files.length} package versions and the iOS app to ${newVersion}`,
);
