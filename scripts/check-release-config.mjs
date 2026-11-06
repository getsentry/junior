#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function readFile(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function collectMatches(text, pattern) {
  return [
    ...new Set([...text.matchAll(pattern)].map((match) => match[1])),
  ].sort();
}

function collectSectionPackages(relativePath, anchor) {
  const text = readFile(relativePath);
  const anchorIndex = text.indexOf(anchor);

  if (anchorIndex === -1) {
    throw new Error(`Missing anchor in ${relativePath}: ${anchor}`);
  }

  const afterAnchor = text.slice(anchorIndex + anchor.length);
  const nextHeadingIndex = afterAnchor.search(/^##\s/m);
  const section =
    nextHeadingIndex === -1
      ? afterAnchor
      : afterAnchor.slice(0, nextHeadingIndex);

  return collectMatches(section, /`(@sentry\/[^`]+)`/g);
}

function collectPublishablePackages() {
  return fs
    .readdirSync(path.join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/package.json`)
    .filter((relativePath) => fs.existsSync(path.join(root, relativePath)))
    .map((relativePath) => {
      const packageJson = JSON.parse(readFile(relativePath));

      if (packageJson.private === true) {
        return null;
      }

      if (
        typeof packageJson.name !== "string" ||
        packageJson.name.length === 0
      ) {
        throw new Error(
          `${relativePath} is publishable but missing a package name.`,
        );
      }

      return packageJson;
    })
    .filter((packageJson) => packageJson !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function collectBumpPackages() {
  const packageFiles = collectMatches(
    readFile("scripts/bump-release-versions.mjs"),
    /"(packages\/[^"]+\/package\.json)"/g,
  );

  return packageFiles
    .map((relativePath) => JSON.parse(readFile(relativePath)).name)
    .sort();
}

function collectCiPackages() {
  return collectMatches(
    readFile(".github/workflows/ci.yml"),
    /pnpm --filter (@sentry\/[^\s]+) pack --pack-destination artifacts/g,
  );
}

function collectPackageLintPackages() {
  const packageJson = JSON.parse(readFile("package.json"));
  const packageLintScript = packageJson.scripts?.["package:lint"];

  if (typeof packageLintScript !== "string") {
    throw new Error("Missing package.json script: package:lint");
  }

  const packageFiles = collectMatches(
    packageLintScript,
    /\b(packages\/[^\s";]+)/g,
  ).map((relativePath) => `${relativePath}/package.json`);

  return packageFiles
    .map((relativePath) => JSON.parse(readFile(relativePath)).name)
    .sort();
}

function describeMismatch(expected, actual) {
  const missing = expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));

  if (missing.length === 0 && extra.length === 0) {
    return null;
  }

  return { missing, extra };
}

// Craft must create the approved tag before npm. Only the tag workflow publishes assets.
// The npm target publishes every public workspace package, so it has no list to check.
const craftConfig = readFile(".craft.yml");
assert.match(
  craftConfig,
  /^targets:\n  - name: github\n    tagOnly: true\n  - name: npm\n    workspaces: true$/m,
  "Craft must create the release tag before publishing every workspace package to npm.",
);
assert.equal(
  [...craftConfig.matchAll(/^  - name: github$/gm)].length,
  1,
  "The tag workflow must be the only GitHub Release publisher.",
);

const publishablePackages = collectPublishablePackages();

// Lockstep releases need one source version. The pack job asserts this too,
// but it runs only on main, so check here to fail the pull request instead.
const [releasePackage] = publishablePackages;
const offVersion = publishablePackages.filter(
  (pkg) => pkg.version !== releasePackage.version,
);
if (offVersion.length > 0) {
  console.error(
    `Release config check failed: expected every package at ${releasePackage.name}@${releasePackage.version}.`,
  );
  for (const pkg of offVersion) {
    console.error(`  ${pkg.name}: ${pkg.version}`);
  }
  process.exit(1);
}

const sources = [
  {
    label: "packages/*/package.json",
    packages: publishablePackages.map((pkg) => pkg.name),
  },
  {
    label: "scripts/bump-release-versions.mjs",
    packages: collectBumpPackages(),
  },
  {
    label: ".github/workflows/ci.yml",
    packages: collectCiPackages(),
  },
  {
    label: "package.json package:lint",
    packages: collectPackageLintPackages(),
  },
  {
    label: "README.md",
    packages: collectSectionPackages("README.md", "## Packages"),
  },
  {
    label: "CONTRIBUTING.md",
    packages: collectSectionPackages(
      "CONTRIBUTING.md",
      "This repo uses Craft for manual lockstep npm releases of:",
    ),
  },
  {
    label: "packages/docs/src/content/docs/contribute/releasing.md",
    packages: collectSectionPackages(
      "packages/docs/src/content/docs/contribute/releasing.md",
      "Junior uses lockstep package releases for:",
    ),
  },
];

const [expectedSource, ...otherSources] = sources;

if (expectedSource.packages.length === 0) {
  console.error(
    "Release config check failed: no publishable packages found in packages/*/package.json.",
  );
  process.exit(1);
}

let hasMismatch = false;

for (const source of otherSources) {
  const mismatch = describeMismatch(expectedSource.packages, source.packages);

  if (!mismatch) {
    continue;
  }

  hasMismatch = true;
  console.error(`Release config mismatch in ${source.label}:`);

  if (mismatch.missing.length > 0) {
    console.error(`  Missing: ${mismatch.missing.join(", ")}`);
  }

  if (mismatch.extra.length > 0) {
    console.error(`  Extra: ${mismatch.extra.join(", ")}`);
  }
}

if (hasMismatch) {
  console.error(
    "Release config check failed. Align release package lists with packages/*/package.json.",
  );
  process.exit(1);
}

console.log(
  `Release config OK: ${expectedSource.packages.length} publishable packages aligned across ${sources.length} sources.`,
);
