import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fileLengthExceptions } from "./file-length-exceptions.mjs";

export const MAX_CODE_FILE_LINES = 1_000;

const CODE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
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
      `${file.path}: ${file.lines} lines exceeds the ${maxLines}-line limit`,
    );
  }

  return errors;
}

function collectCodeFiles(root, directory = root, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectCodeFiles(root, absolutePath, files);
      continue;
    }
    if (!entry.isFile() || !CODE_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }
    files.push({
      path: path.relative(root, absolutePath).split(path.sep).join("/"),
      lines: countFileLines(fs.readFileSync(absolutePath, "utf8")),
    });
  }
  return files;
}

function main() {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, "..");
  const errors = checkFileLengths(collectCodeFiles(root), fileLengthExceptions);
  if (errors.length === 0) {
    console.log(`All code files are at most ${MAX_CODE_FILE_LINES} lines.`);
    return;
  }
  console.error(["File length check failed:", ...errors].join("\n"));
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
