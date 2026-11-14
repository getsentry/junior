#!/usr/bin/env node
// Packs each public workspace package that ships types and checks the
// tarball with attw. The list comes from packages/*/package.json, so a new
// package is checked without a script change.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), "junior-attw-"));

function shipsTypes(packageJson) {
  return (
    typeof packageJson.types === "string" ||
    JSON.stringify(packageJson.exports ?? {}).includes('"types"')
  );
}

const packageDirs = fs
  .readdirSync(path.join(root, "packages"))
  .map((name) => path.join(root, "packages", name))
  .filter((dir) => fs.existsSync(path.join(dir, "package.json")))
  .filter((dir) => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    );
    return packageJson.private !== true && shipsTypes(packageJson);
  });

try {
  for (const dir of packageDirs) {
    const archive = path.join(archiveDir, `${path.basename(dir)}.tgz`);
    execFileSync(
      "pnpm",
      ["--dir", dir, "--config.ignore-scripts=true", "pack", "--out", archive],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    execFileSync(
      "pnpm",
      [
        "--dir",
        root,
        "exec",
        "attw",
        archive,
        "--profile",
        "esm-only",
        "--quiet",
      ],
      { stdio: "inherit" },
    );
  }
} finally {
  fs.rmSync(archiveDir, { force: true, recursive: true });
}

console.log(`attw passed for ${packageDirs.length} packages.`);
