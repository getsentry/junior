import fs from "node:fs/promises";
import path from "node:path";

const packageRoot = process.cwd();
const srcRoot = path.join(packageRoot, "src");
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const FORBIDDEN_PLUGIN_PACKAGE_RE =
  /(?:from\s+["']|import\s*\(\s*["'])(@sentry\/junior-[^"']+)["']/g;
const ALLOWED_CORE_PACKAGES = new Set(["@sentry/junior-plugin-api"]);

async function listFilesRecursive(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const nextPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(nextPath)));
      continue;
    }
    files.push(nextPath);
  }

  return files;
}

function toRelative(filePath) {
  return path.relative(packageRoot, filePath).split(path.sep).join("/");
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

async function main() {
  const violations = [];
  const files = (await listFilesRecursive(srcRoot)).filter((filePath) =>
    SOURCE_EXTENSIONS.has(path.extname(filePath)),
  );

  for (const filePath of files) {
    const source = await fs.readFile(filePath, "utf8");
    for (const match of source.matchAll(FORBIDDEN_PLUGIN_PACKAGE_RE)) {
      const packageName = match[1];
      if (ALLOWED_CORE_PACKAGES.has(packageName)) {
        continue;
      }
      violations.push(
        `${toRelative(filePath)}:${lineNumberForOffset(source, match.index ?? 0)} imports plugin package ${packageName}`,
      );
    }
  }

  if (violations.length > 0) {
    console.error("Core package boundary check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Core package boundary check passed.");
}

await main();
