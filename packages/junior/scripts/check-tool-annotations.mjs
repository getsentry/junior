import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TOOL_CONSTRUCTORS = new Set(["definePluginTool", "tool", "zodTool"]);
const REQUIRED_HINTS = [
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
  "readOnlyHint",
];

function propertyName(property, sourceFile) {
  if (!property.name) {
    return undefined;
  }
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return property.name.getText(sourceFile);
}

function annotationErrors(call, sourceFile, filePath) {
  const line =
    sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line +
    1;
  const prefix = `${filePath}:${line}`;
  const definition = call.arguments[0];
  if (!definition || !ts.isObjectLiteralExpression(definition)) {
    return [`${prefix}: repo tool definition must use an object literal`];
  }

  const annotationsProperty = definition.properties.find(
    (property) => propertyName(property, sourceFile) === "annotations",
  );
  if (
    !annotationsProperty ||
    !ts.isPropertyAssignment(annotationsProperty) ||
    !ts.isObjectLiteralExpression(annotationsProperty.initializer)
  ) {
    return [
      `${prefix}: repo tool must declare annotations with ${REQUIRED_HINTS.join(", ")}`,
    ];
  }

  const values = new Map();
  for (const property of annotationsProperty.initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = propertyName(property, sourceFile);
    if (!name || !REQUIRED_HINTS.includes(name)) {
      continue;
    }
    if (
      property.initializer.kind !== ts.SyntaxKind.TrueKeyword &&
      property.initializer.kind !== ts.SyntaxKind.FalseKeyword
    ) {
      values.set(name, "non-boolean");
      continue;
    }
    values.set(name, property.initializer.kind === ts.SyntaxKind.TrueKeyword);
  }

  const errors = [];
  const missing = REQUIRED_HINTS.filter((hint) => !values.has(hint));
  if (missing.length > 0) {
    errors.push(
      `${prefix}: repo tool annotations missing ${missing.join(", ")}`,
    );
  }
  const nonBoolean = REQUIRED_HINTS.filter(
    (hint) => values.get(hint) === "non-boolean",
  );
  if (nonBoolean.length > 0) {
    errors.push(
      `${prefix}: repo tool annotations must use boolean literals for ${nonBoolean.join(", ")}`,
    );
  }
  if (
    values.get("readOnlyHint") === true &&
    values.get("destructiveHint") === true
  ) {
    errors.push(
      `${prefix}: read-only tools cannot declare destructiveHint: true`,
    );
  }
  return errors;
}

/** Check one source file for complete repo-owned tool annotations. */
export function checkToolAnnotationSource(source, filePath = "tool.ts") {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const errors = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      TOOL_CONSTRUCTORS.has(node.expression.text)
    ) {
      errors.push(...annotationErrors(node, sourceFile, filePath));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

async function sourceFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

/** Check every repo package source file for complete tool annotations. */
export async function checkRepoToolAnnotations(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs.readdir(packagesRoot, {
    withFileTypes: true,
  });
  const errors = [];
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory()) {
      continue;
    }
    const sourceRoot = path.join(packagesRoot, packageEntry.name, "src");
    try {
      for (const filePath of await sourceFiles(sourceRoot)) {
        const source = await fs.readFile(filePath, "utf8");
        errors.push(
          ...checkToolAnnotationSource(
            source,
            path.relative(repoRoot, filePath),
          ),
        );
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return errors;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), "../../..");
  const errors = await checkRepoToolAnnotations(repoRoot);
  if (errors.length > 0) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
