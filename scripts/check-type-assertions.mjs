import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Type assertion ratchet for production source. A type assertion (`x as T` or
 * `<T>x`) tells the compiler to trust a shape that nothing checked. Data must
 * be parsed at its edge, and later code must use the parsed types. The
 * baseline lists the per-file count of the assertions that existed when this
 * check was added. A count can only go down.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const AST_GREP = path.join(REPO_ROOT, "node_modules/.bin/ast-grep");
const BASELINE_PATH = "scripts/type-assertions-baseline.json";
// Test harness packages. They are not production source.
const EXCLUDED_PACKAGES = new Set(["junior-evals", "junior-testing"]);
const TEST_FILE = /\.(?:test|spec)\.[cm]?tsx?$|\/(?:__tests__|fixtures?)\//;
const MESSAGE =
  "Do not add type assertions (`as T`, `<T>x`). Parse unknown input with its owning zod schema at the edge, narrow with a discriminant or a type guard, or use `satisfies` to check a value against a type. See policies/runtime-boundary-schemas.md.";

// `as const` only narrows a literal, so it is not counted. A chain such as
// `x as unknown as T` counts as two assertions.
// `.tsx` files have no `<T>x` form, because it would parse as JSX.
const RULES = `id: type-assertion-ts
language: TypeScript
rule:
  any:
    - kind: type_assertion
    - all:
        - kind: as_expression
        - not: { pattern: $X as const }
---
id: type-assertion-tsx
language: Tsx
rule:
  all:
    - kind: as_expression
    - not: { pattern: $X as const }`;

/** Say whether a repository path is production source that this check counts. */
export function isCheckedFile(filePath) {
  const [group, packageName, sourceDirectory] = filePath.split("/");
  return (
    group === "packages" &&
    sourceDirectory === "src" &&
    !EXCLUDED_PACKAGES.has(packageName) &&
    !TEST_FILE.test(filePath)
  );
}

/**
 * Count type assertions per file with the ast-grep TypeScript parser, so
 * comments, strings, and import aliases are not counted. Paths in the result
 * are relative to `root`.
 */
export function countTypeAssertions(root, targets) {
  const output = execFileSync(
    AST_GREP,
    ["scan", "--inline-rules", RULES, "--json=stream", ...targets],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const counts = {};
  for (const line of output.split("\n")) {
    if (!line) continue;
    const file = JSON.parse(line).file.split(path.sep).join("/");
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

/**
 * Report files with more assertions than the baseline allows, and baseline
 * entries that are now too high, so the baseline only gets smaller.
 */
export function checkTypeAssertions(counts, baseline) {
  const errors = [];
  for (const [filePath, actual] of Object.entries(counts)) {
    const allowed = baseline[filePath] ?? 0;
    if (actual > allowed) {
      errors.push(
        `${filePath}: type assertions: ${actual} found, baseline allows ${allowed}. ${MESSAGE}`,
      );
    }
  }
  for (const [filePath, allowed] of Object.entries(baseline)) {
    const actual = counts[filePath] ?? 0;
    if (actual < allowed) {
      errors.push(
        actual === 0
          ? `${filePath}: type assertions: 0 found, baseline allows ${allowed}. Remove the entry from ${BASELINE_PATH}.`
          : `${filePath}: type assertions: ${actual} found, baseline allows ${allowed}. Lower the entry in ${BASELINE_PATH} to ${actual}.`,
      );
    }
  }
  return errors;
}

function sourceDirectories(root) {
  return fs
    .readdirSync(path.join(root, "packages"))
    .filter((name) => !EXCLUDED_PACKAGES.has(name))
    .map((name) => `packages/${name}/src`)
    .filter((directory) => fs.existsSync(path.join(root, directory)));
}

function main() {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, BASELINE_PATH), "utf8"),
  );
  const counts = Object.fromEntries(
    Object.entries(
      countTypeAssertions(REPO_ROOT, sourceDirectories(REPO_ROOT)),
    ).filter(([filePath]) => isCheckedFile(filePath)),
  );
  const errors = checkTypeAssertions(counts, baseline);
  if (errors.length === 0) {
    console.log("Production source adds no type assertions.");
    return;
  }
  console.error(
    [
      "Type assertion check failed:",
      ...errors,
      `Fix the code. Do not hide the assertion in a helper, and do not add or raise entries in ${BASELINE_PATH}, to pass. When you move a file, move its entry.`,
    ].join("\n"),
  );
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
