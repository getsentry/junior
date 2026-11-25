import path from "node:path";

// Imports name these files without an extension.
const MODULE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);

/**
 * Report modules in one directory whose names differ only in case, such as
 * `PeoplePicker.tsx` and `peoplePicker.ts`. Imports omit the extension, so
 * on a case-insensitive file system an import of one can load the other.
 */
export function checkPathCase(files) {
  const seen = new Map();
  const errors = [];
  for (const file of [...files].sort()) {
    const ext = path.posix.extname(file);
    if (!MODULE_EXTENSIONS.has(ext)) continue;
    const stem = file.slice(0, file.length - ext.length);
    const key = stem.toLowerCase();
    const other = seen.get(key);
    if (other === undefined) {
      seen.set(key, { file, stem });
    } else if (other.stem !== stem) {
      errors.push(
        `${file}: its name differs only in case from ${other.file}. Give one of them a name that says its role.`,
      );
    }
  }
  return errors;
}

/** Check every repo file. */
export function run({ files }) {
  return checkPathCase(files);
}
