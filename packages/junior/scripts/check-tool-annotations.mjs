import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@typescript/typescript6";

const TOOL_CONSTRUCTORS = new Set(["definePluginTool", "tool", "zodTool"]);
// Static core definitions declare the annotations. A tool built from one gets
// them from there.
const DEFINITION_DECLARERS = new Set(["zodToolDefinition"]);
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

// A static definition, such as `bashToolDefinition` or
// `replyToolDefinition(target)`, by its name.
function namesDefinition(expression, sourceFile) {
  return /definitions?\b/i.test(expression.getText(sourceFile));
}

function annotationErrors(call, sourceFile, filePath) {
  const line =
    sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile)).line +
    1;
  const prefix = `${filePath}:${line}`;
  const definition = call.arguments[0];
  // Only core `zodTool` tools are built from static definitions. Plugin tools
  // declare everything inline in `definePluginTool`.
  const builtFromDefinition = call.expression.text === "zodTool";
  if (
    builtFromDefinition &&
    definition &&
    !ts.isObjectLiteralExpression(definition) &&
    namesDefinition(definition, sourceFile)
  ) {
    return [];
  }
  if (!definition || !ts.isObjectLiteralExpression(definition)) {
    return [`${prefix}: repo tool definition must use an object literal`];
  }

  const annotationsProperty = definition.properties.find(
    (property) => propertyName(property, sourceFile) === "annotations",
  );
  if (
    builtFromDefinition &&
    !annotationsProperty &&
    definition.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) &&
        namesDefinition(property.expression, sourceFile),
    )
  ) {
    return [];
  }
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
      (TOOL_CONSTRUCTORS.has(node.expression.text) ||
        DEFINITION_DECLARERS.has(node.expression.text))
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

// Model-facing fields that a static core tool takes from its registry
// definition. Plugin tools are context-free, so `definePluginTool` keeps them
// inline.
const DEFINITION_FIELDS = new Set(["description", "inputSchema"]);
const INLINE_DEFINITION_CONSTRUCTORS = new Set(["zodTool"]);
// Built by each run from its planned tool exposure, after `createTools`.
// Their descriptions list the tools of the run.
const EXPOSURE_BUILT_TOOL_NAMES = ["codemode", "searchTools"];
const REGISTRY_PATH = "packages/junior/src/chat/tools/registry.ts";

/**
 * Read the run-built slot names from the source of the static tool registry
 * (`CORE_TOOLS` entries that are `RUN_BUILT` or set `runBuilt: true`).
 */
export function runBuiltToolNames(registrySource) {
  const sourceFile = ts.createSourceFile(
    "registry.ts",
    registrySource,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set();
  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "CORE_TOOLS" &&
      node.initializer
    ) {
      const table = ts.isSatisfiesExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      if (!ts.isObjectLiteralExpression(table)) return;
      for (const property of table.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const entry = property.initializer;
        if (ts.isIdentifier(entry) && entry.text === "RUN_BUILT") {
          names.add(propertyName(property, sourceFile));
        } else if (ts.isObjectLiteralExpression(entry)) {
          const fields = new Map(
            entry.properties
              .filter(ts.isPropertyAssignment)
              .map((field) => [
                propertyName(field, sourceFile),
                field.initializer,
              ]),
          );
          if (fields.get("runBuilt")?.kind !== ts.SyntaxKind.TrueKeyword) {
            continue;
          }
          const name = fields.get("name");
          names.add(
            name && ts.isStringLiteral(name)
              ? name.text
              : propertyName(property, sourceFile),
          );
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return names;
}

// The `@runBuilt <tool>` tag on the function or variable that builds the
// tool.
function runBuiltTag(node) {
  for (let current = node; current; current = current.parent) {
    for (const tag of ts.getJSDocTags(current)) {
      if (tag.tagName.text !== "runBuilt") continue;
      const comment =
        typeof tag.comment === "string"
          ? tag.comment
          : (tag.comment ?? []).map((part) => part.text).join("");
      return comment.trim().split(/\s+/)[0] ?? "";
    }
  }
  return undefined;
}

/**
 * Check that tools take `description` and `inputSchema` from a static
 * definition. Only a factory tagged `@runBuilt <tool>`, for a tool that
 * each run builds, may write them inline.
 */
export function checkToolDefinitionSource(
  source,
  filePath = "tool.ts",
  runBuiltNames = new Set(),
) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const errors = [];

  function visit(node) {
    const definition = node.arguments?.[0];
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      INLINE_DEFINITION_CONSTRUCTORS.has(node.expression.text) &&
      definition &&
      ts.isObjectLiteralExpression(definition)
    ) {
      const inline = definition.properties
        .map((property) => propertyName(property, sourceFile))
        .filter((name) => DEFINITION_FIELDS.has(name));
      if (inline.length > 0) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            .line + 1;
        const prefix = `${filePath}:${line}`;
        const tool = runBuiltTag(node);
        if (tool === undefined) {
          errors.push(
            `${prefix}: ${inline.join(", ")} must come from the static tool registry; a run-built tool factory needs @runBuilt <tool>`,
          );
        } else if (!runBuiltNames.has(tool)) {
          errors.push(
            `${prefix}: @runBuilt ${tool || "(none)"} is not a run-built tool`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return errors;
}

/** Check every repo package source file for complete tool annotations. */
export async function checkRepoToolAnnotations(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs.readdir(packagesRoot, {
    withFileTypes: true,
  });
  const runBuiltNames = new Set([
    ...runBuiltToolNames(
      await fs.readFile(path.join(repoRoot, REGISTRY_PATH), "utf8"),
    ),
    ...EXPOSURE_BUILT_TOOL_NAMES,
  ]);
  const errors = [];
  for (const packageEntry of packageEntries) {
    if (!packageEntry.isDirectory()) {
      continue;
    }
    const sourceRoot = path.join(packagesRoot, packageEntry.name, "src");
    try {
      for (const filePath of await sourceFiles(sourceRoot)) {
        const source = await fs.readFile(filePath, "utf8");
        const relativePath = path.relative(repoRoot, filePath);
        errors.push(
          ...checkToolAnnotationSource(source, relativePath),
          ...checkToolDefinitionSource(source, relativePath, runBuiltNames),
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
