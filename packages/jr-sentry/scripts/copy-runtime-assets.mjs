import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const outputRoot = path.join(projectRoot, ".next", "server", "runtime-assets");
const assetDirs = ["data", "skills", "plugins"];

fs.mkdirSync(outputRoot, { recursive: true });

for (const dirName of assetDirs) {
  const sourceDir = path.join(projectRoot, dirName);
  if (!fs.existsSync(sourceDir)) {
    continue;
  }

  const destinationDir = path.join(outputRoot, dirName);
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });
}

const copiedSoul = path.join(outputRoot, "data", "SOUL.md");
if (!fs.existsSync(copiedSoul)) {
  throw new Error(`Runtime asset copy missing SOUL.md: ${copiedSoul}`);
}

console.log(`Copied runtime assets to ${outputRoot}`);
