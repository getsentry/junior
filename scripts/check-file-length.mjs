import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileLengthExceptions } from "./file-length-exceptions.mjs";

export const MAX_CODE_FILE_LINES = 1_000;
export const MAX_DOC_FILE_LINES = 120;

// Agents read this text as the fix instruction, so it must name the intended
// fix and the shortcuts that only hide the size.
const SPLIT_GUIDANCE =
  "Split it into smaller modules or test files at a clear feature, " +
  "ownership, or behavior boundary. Do not delete code, comments, or tests, " +
  "compress formatting, or add a file-length exception to pass. " +
  "See policies/correctness-complexity.md.";

const DOC_GUIDANCE =
  "Keep only intent, invariants, and boundaries. Move facts that one symbol " +
  "owns into its JSDoc and procedures into a skill. See " +
  "policies/documentation.md.";

const CODE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const DOC_FILENAMES = new Set(["AGENTS.md", "README.md"]);
const ROOT_DOC_PATHS = new Set(["TELEMETRY.md", "TERMINOLOGY.md"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

/** Count physical lines without treating a final newline as another line. */
export function countFileLines(contents) {
  if (contents.length === 0) {
    return 0;
  }
  const breaks = contents.match(/\r\n|\r|\n/g)?.length ?? 0;
  return breaks + (/\r\n$|\r$|\n$/.test(contents) ? 0 : 1);
}

/** Report oversized files and stale or invalid exceptions. */
export function checkFileLengths(
  files,
  exceptions,
  maxLines = MAX_CODE_FILE_LINES,
  guidance = SPLIT_GUIDANCE,
) {
  const errors = [];
  const filesByPath = new Map(files.map((file) => [file.path, file.lines]));

  for (const [filePath, reason] of Object.entries(exceptions)) {
    if (typeof reason !== "string" || !reason.trim()) {
      errors.push(`${filePath}: file-length exception needs a reason`);
      continue;
    }
    const lines = filesByPath.get(filePath);
    if (lines === undefined) {
      errors.push(
        `${filePath}: file-length exception points to a missing file`,
      );
    } else if (lines <= maxLines) {
      errors.push(
        `${filePath}: now has ${lines} lines; remove its file-length exception`,
      );
    }
  }

  for (const file of files) {
    if (file.lines <= maxLines || exceptions[file.path]) {
      continue;
    }
    errors.push(
      `${file.path}: ${file.lines} lines exceeds the ${maxLines}-line limit. ${guidance}`,
    );
  }

  return errors;
}

/** Internal docs: every AGENTS.md and README.md, policies, and root references. */
export function isInternalDoc(filePath) {
  return (
    DOC_FILENAMES.has(path.posix.basename(filePath)) ||
    ROOT_DOC_PATHS.has(filePath) ||
    /^policies\/[^/]+\.md$/.test(filePath)
  );
}

function collectFiles(root, include, directory = root, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(root, include, absolutePath, files);
      continue;
    }
    const filePath = path
      .relative(root, absolutePath)
      .split(path.sep)
      .join("/");
    if (!entry.isFile() || !include(filePath)) {
      continue;
    }
    files.push({
      path: filePath,
      lines: countFileLines(fs.readFileSync(absolutePath, "utf8")),
    });
  }
  return files;
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const errors = [
    ...checkFileLengths(
      collectFiles(root, (filePath) =>
        CODE_EXTENSIONS.has(path.posix.extname(filePath)),
      ),
      fileLengthExceptions,
    ),
    ...checkFileLengths(
      collectFiles(root, isInternalDoc),
      {},
      MAX_DOC_FILE_LINES,
      DOC_GUIDANCE,
    ),
  ];
  if (errors.length === 0) {
    console.log(
      `All code files are at most ${MAX_CODE_FILE_LINES} lines and internal docs at most ${MAX_DOC_FILE_LINES} lines.`,
    );
    return;
  }
  console.error(["File length check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
