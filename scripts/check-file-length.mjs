import path from "node:path";
import { fileLengthExceptions } from "./file-length-exceptions.mjs";
import { readRepoFiles } from "./lib/repo-files.mjs";

export const MAX_CODE_FILE_LINES = 1_000;
const MAX_DOC_FILE_LINES = 120;

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

const NESTED_AGENTS_GUIDANCE =
  "Only the repo root has an AGENTS.md. Put intent in a code comment next " +
  "to the code that it governs. See policies/documentation.md.";

const CODE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const DOC_FILENAMES = new Set(["AGENTS.md", "README.md"]);
const REFERENCE_DOC_PATHS = new Set(["TELEMETRY.md", "TERMINOLOGY.md"]);
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

/** Core docs agents read before a change: AGENTS.md, README.md, and policies. */
export function isCoreDoc(filePath) {
  return (
    DOC_FILENAMES.has(path.posix.basename(filePath)) ||
    /^policies\/[^/]+\.md$/.test(filePath)
  );
}

/** An AGENTS.md below the repo root. */
export function isNestedAgentsDoc(filePath) {
  return (
    filePath !== "AGENTS.md" && path.posix.basename(filePath) === "AGENTS.md"
  );
}

/** Reference docs that agents look up. They may be long, but not unbounded. */
export function isReferenceDoc(filePath) {
  return REFERENCE_DOC_PATHS.has(filePath);
}

/** Check code, core doc, and reference doc lengths, and nested AGENTS.md files. */
export async function run({ root, files }) {
  const measure = async (include) =>
    (await readRepoFiles(root, files.filter(include))).map((file) => ({
      path: file.path,
      lines: countFileLines(file.contents),
    }));
  return [
    ...checkFileLengths(
      await measure((filePath) =>
        CODE_EXTENSIONS.has(path.posix.extname(filePath)),
      ),
      fileLengthExceptions,
    ),
    ...checkFileLengths(
      await measure(isCoreDoc),
      {},
      MAX_DOC_FILE_LINES,
      DOC_GUIDANCE,
    ),
    ...checkFileLengths(
      await measure(isReferenceDoc),
      {},
      MAX_CODE_FILE_LINES,
      DOC_GUIDANCE,
    ),
    ...files
      .filter(isNestedAgentsDoc)
      .map((filePath) => `${filePath}: ${NESTED_AGENTS_GUIDANCE}`),
  ];
}
