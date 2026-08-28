import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const BASELINE_RELATIVE_PATH =
  "packages/junior/scripts/tool-error-classification-baseline.txt";

function isUnderToolsPath(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (!normalized.startsWith("packages/") || !normalized.includes("/src/")) {
    return false;
  }
  if (normalized.endsWith(".d.ts") || normalized.includes("/tests/")) {
    return false;
  }
  return (
    normalized.includes("/src/") &&
    (normalized.includes("/tools/") ||
      normalized.startsWith("packages/junior/src/chat/tools/"))
  );
}

function normalizeSnippet(text) {
  return text.replace(/\s+/g, " ").trim();
}

function throwSnippet(node, sourceFile) {
  const text = node.getText(sourceFile);
  return normalizeSnippet(text.endsWith(";") ? text : `${text};`);
}

function isPlainErrorThrow(node) {
  if (!ts.isThrowStatement(node) || !node.expression) {
    return false;
  }
  if (!ts.isNewExpression(node.expression)) {
    return false;
  }
  const expression = node.expression.expression;
  return ts.isIdentifier(expression) && expression.text === "Error";
}

/** Collect plain `throw new Error(...)` signatures under tool source paths. */
export function collectToolErrorThrows(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const signatures = [];

  function visit(node) {
    if (isPlainErrorThrow(node)) {
      signatures.push(`${filePath}\t${throwSnippet(node, sourceFile)}`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return signatures;
}

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "tests"
      ) {
        continue;
      }
      files.push(...(await sourceFiles(entryPath)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

/** Load baseline signatures as a sorted unique list. */
export function parseBaseline(text) {
  return [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    ),
  ].sort();
}

/** Compare current tool plain-Error throws against the approved baseline. */
export function diffToolErrorBaseline(current, baseline) {
  const currentSet = new Set(current);
  const baselineSet = new Set(baseline);
  const unexpected = [...currentSet]
    .filter((entry) => !baselineSet.has(entry))
    .sort();
  const stale = [...baselineSet]
    .filter((entry) => !currentSet.has(entry))
    .sort();
  return { unexpected, stale };
}

/** Scan repo packages for plain Error throws in tool source paths. */
export async function collectRepoToolErrorThrows(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs.readdir(packagesRoot, {
    withFileTypes: true,
  });
  const signatures = [];
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory()) {
      continue;
    }
    const sourceRoot = path.join(packagesRoot, packageEntry.name, "src");
    try {
      for (const filePath of await sourceFiles(sourceRoot)) {
        const relativePath = path
          .relative(repoRoot, filePath)
          .split(path.sep)
          .join("/");
        if (!isUnderToolsPath(relativePath)) {
          continue;
        }
        const source = await fs.readFile(filePath, "utf8");
        signatures.push(...collectToolErrorThrows(source, relativePath));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return [...new Set(signatures)].sort();
}

/** Check that no new plain Error throws land under tool paths. */
export async function checkRepoToolErrorClassification(repoRoot) {
  const baselinePath = path.join(repoRoot, BASELINE_RELATIVE_PATH);
  const baselineText = await fs.readFile(baselinePath, "utf8");
  const baseline = parseBaseline(baselineText);
  const current = await collectRepoToolErrorThrows(repoRoot);
  const { unexpected, stale } = diffToolErrorBaseline(current, baseline);
  const errors = [];
  for (const entry of unexpected) {
    errors.push(
      `${entry.split("\t")[0]}: new plain Error throw in tool code; use ToolInputError/PluginToolInputError for model-repairable failures, or update ${BASELINE_RELATIVE_PATH} only for true system failures: ${entry.split("\t")[1]}`,
    );
  }
  for (const entry of stale) {
    errors.push(
      `${entry.split("\t")[0]}: stale tool-error baseline entry; remove it from ${BASELINE_RELATIVE_PATH}: ${entry.split("\t")[1]}`,
    );
  }
  return errors;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
  if (process.argv.includes("--write-baseline")) {
    const current = await collectRepoToolErrorThrows(repoRoot);
    const body = [
      "# Approved plain `throw new Error(...)` sites under tool source paths.",
      "# Model-repairable failures must use ToolInputError or PluginToolInputError.",
      "# Only keep true system/config/integrity failures here.",
      "# Format: relativePath<TAB>normalized throw statement",
      ...current,
      "",
    ].join("\n");
    await fs.writeFile(path.join(repoRoot, BASELINE_RELATIVE_PATH), body);
    console.log(`Wrote ${current.length} baseline entries.`);
  } else {
    const errors = await checkRepoToolErrorClassification(repoRoot);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    }
  }
}
