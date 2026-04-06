import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const CHAT_SRC_ROOT = path.join(repoRoot, "src", "chat");

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/**
 * Import direction boundary rules from specs/chat-architecture-spec.md.
 *
 * Each rule scans source files under `scanRoot` (excluding `excludeDirs`)
 * and reports any import matching a `forbiddenPatterns` entry.
 */
const BOUNDARY_RULES = [
  {
    name: "non-app modules must not import from app/",
    scanRoot: CHAT_SRC_ROOT,
    excludeDirs: [path.join(CHAT_SRC_ROOT, "app")],
    forbiddenPatterns: [/from\s+["']@\/chat\/app\//],
  },
  {
    name: "services/ must not import from runtime/",
    scanRoot: path.join(CHAT_SRC_ROOT, "services"),
    forbiddenPatterns: [/from\s+["']@\/chat\/runtime\//],
  },
  {
    name: "state/ must not import from runtime/",
    scanRoot: path.join(CHAT_SRC_ROOT, "state"),
    forbiddenPatterns: [/from\s+["']@\/chat\/runtime\//],
  },
  {
    name: "state/ must not import from services/",
    scanRoot: path.join(CHAT_SRC_ROOT, "state"),
    forbiddenPatterns: [/from\s+["']@\/chat\/services\//],
  },
];

/**
 * Feature subdirectories that must not contain barrel index.ts re-exports.
 * Module-root index.ts files (e.g. tools/index.ts) are fine.
 */
const FEATURE_SUBDIRECTORY_PARENTS = [
  "tools/sandbox",
  "tools/slack",
  "tools/web",
  "tools/skill",
  "plugins/auth",
];

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

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
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function findPatternLineNumbers(source, pattern) {
  const lines = source.split("\n");
  const lineNumbers = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) {
      lineNumbers.push(index + 1);
    }
  }

  return lineNumbers;
}

async function checkImportBoundaries() {
  const violations = [];

  for (const rule of BOUNDARY_RULES) {
    if (!(await pathExists(rule.scanRoot))) {
      continue;
    }

    const allFiles = await listFilesRecursive(rule.scanRoot);
    const sourceFiles = allFiles.filter((filePath) =>
      SOURCE_EXTENSIONS.has(path.extname(filePath)),
    );

    for (const filePath of sourceFiles) {
      if (
        rule.excludeDirs?.some((dir) => filePath.startsWith(dir + path.sep))
      ) {
        continue;
      }

      const source = await fs.readFile(filePath, "utf8");

      for (const pattern of rule.forbiddenPatterns) {
        const lineNumbers = findPatternLineNumbers(source, pattern);
        if (lineNumbers.length === 0) {
          continue;
        }
        violations.push(
          `[${rule.name}] Forbidden import in ${toRelative(filePath)} at line(s): ${lineNumbers.join(", ")}`,
        );
      }
    }
  }

  return violations;
}

async function checkFeatureSubdirectoryBarrels() {
  const violations = [];

  for (const subdir of FEATURE_SUBDIRECTORY_PARENTS) {
    const indexPath = path.join(CHAT_SRC_ROOT, subdir, "index.ts");
    if (await pathExists(indexPath)) {
      violations.push(
        `Barrel index.ts found in feature subdirectory: ${toRelative(indexPath)}`,
      );
    }
  }

  return violations;
}

async function main() {
  const violations = [
    ...(await checkImportBoundaries()),
    ...(await checkFeatureSubdirectoryBarrels()),
  ];

  if (violations.length > 0) {
    console.error("Chat architecture boundary check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log("Chat architecture boundary check passed.");
}

await main();
