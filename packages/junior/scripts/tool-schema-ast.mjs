import fs from "node:fs/promises";
import path from "node:path";
import ts from "@typescript/typescript6";

// Shared AST walk for the tool contract checks. It finds tool definitions and
// follows schema names across files to the object literals that define them.
const TOOL_CONSTRUCTORS = new Set([
  "definePluginTool",
  "pluginToolDefinition",
  "tool",
  "zodTool",
  "zodToolDefinition",
]);
const OBJECT_SCHEMA_CALLS = new Set([
  "Object",
  "extend",
  "looseObject",
  "object",
  "safeExtend",
  "strictObject",
]);

function propertyName(property, sourceFile) {
  if (!property.name) return undefined;
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return property.name.getText(sourceFile);
}

function callName(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function resolveModule(fromFile, specifier, packageSrcRoot) {
  let base;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    base = path.join(path.dirname(fromFile), specifier);
  } else if (specifier.startsWith("@/")) {
    base = path.join(packageSrcRoot, specifier.slice(2));
  } else {
    return undefined;
  }
  return [`${base}.ts`, path.join(base, "index.ts"), base];
}

function parseModule(source, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  // Names map to every declaration in the file, also ones inside function
  // bodies, so a local `const inputSchema` is found. Checking a few extra
  // declarations of the same name is safe.
  const declarations = new Map();
  const declare = (name, node) =>
    declarations.set(name, [...(declarations.get(name) ?? []), node]);
  const collect = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      declare(node.name.text, node.initializer);
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      declare(node.name.text, node);
    }
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const imports = new Map();
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      for (const element of statement.importClause.namedBindings.elements) {
        imports.set(element.name.text, {
          name: (element.propertyName ?? element.name).text,
          specifier: statement.moduleSpecifier.text,
        });
      }
    }
  }
  return { declarations, imports, sourceFile };
}

/**
 * Index source files so tool definitions and the schemas and strings that
 * they name can be walked across files.
 */
export function createToolSourceIndex(files, packageSrcRoots = {}) {
  const modules = new Map(
    Object.entries(files).map(([filePath, source]) => [
      filePath,
      parseModule(source, filePath),
    ]),
  );

  function srcRootOf(filePath) {
    return (
      Object.entries(packageSrcRoots).find(([, root]) =>
        filePath.startsWith(root + path.sep),
      )?.[1] ?? path.dirname(filePath)
    );
  }

  function lookup(filePath, name) {
    const module = modules.get(filePath);
    if (!module) return undefined;
    const nodes = module.declarations.get(name);
    if (nodes) return nodes.map((node) => ({ filePath, node }));
    const imported = module.imports.get(name);
    if (!imported) return undefined;
    const candidates = resolveModule(
      filePath,
      imported.specifier,
      srcRootOf(filePath),
    );
    const target = candidates?.find((candidate) => modules.has(candidate));
    return target ? lookup(target, imported.name) : undefined;
  }

  function lineOf(filePath, node) {
    const { sourceFile } = modules.get(filePath);
    return (
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
      1
    );
  }

  /**
   * Walk a schema expression. `onKey` gets each object schema property and
   * `onDescribe` gets each `.describe(...)` call with the nearest key.
   */
  function walkSchema(filePath, root, { onKey, onDescribe }) {
    const seen = new Set();

    function checkObjectLiteral(filePath, literal) {
      const { sourceFile } = modules.get(filePath);
      for (const property of literal.properties) {
        if (ts.isSpreadAssignment(property)) {
          visit(filePath, property.expression);
          continue;
        }
        const key = propertyName(property, sourceFile);
        if (key) onKey?.(filePath, property, key);
        if (ts.isPropertyAssignment(property)) {
          visit(filePath, property.initializer, key);
        } else if (ts.isShorthandPropertyAssignment(property)) {
          visit(filePath, property.name, key);
        }
      }
    }

    function visitReturns(filePath, node, key) {
      if (ts.isReturnStatement(node)) {
        visit(filePath, node.expression, key);
      } else if (!ts.isFunctionLike(node)) {
        ts.forEachChild(node, (child) => visitReturns(filePath, child, key));
      }
    }

    function visit(filePath, node, key) {
      if (!node) return;
      // A schema helper function: check what it returns, not its whole body.
      if (ts.isFunctionDeclaration(node)) {
        ts.forEachChild(node.body, (child) =>
          visitReturns(filePath, child, key),
        );
        return;
      }
      if (ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node)) {
        for (const found of lookup(filePath, node.text) ?? []) {
          const id = `${found.filePath}#${found.node.pos}`;
          if (seen.has(id)) continue;
          seen.add(id);
          visit(found.filePath, found.node, key);
        }
        return;
      }
      if (ts.isCallExpression(node)) {
        const name = callName(node);
        if (
          name &&
          OBJECT_SCHEMA_CALLS.has(name) &&
          node.arguments[0] &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          checkObjectLiteral(filePath, node.arguments[0]);
        } else if (name && TOOL_CONSTRUCTORS.has(name)) {
          return;
        } else if (
          name === "describe" &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.arguments[0]
        ) {
          onDescribe?.(filePath, node, key);
          visit(filePath, node.expression, key);
          return;
        }
        visit(filePath, node.expression, key);
        for (const argument of node.arguments) visit(filePath, argument, key);
        return;
      }
      if (ts.isPropertyAccessExpression(node)) {
        visit(filePath, node.expression, key);
        return;
      }
      if (
        ts.isArrayLiteralExpression(node) ||
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isConditionalExpression(node)
      ) {
        ts.forEachChild(node, (child) => visit(filePath, child, key));
      }
    }

    visit(filePath, root);
  }

  /** List each tool definition with its top-level property values. */
  function toolDefinitions() {
    const definitions = [];
    for (const [filePath, { sourceFile }] of modules) {
      const walk = (node) => {
        if (
          ts.isCallExpression(node) &&
          TOOL_CONSTRUCTORS.has(callName(node) ?? "") &&
          node.arguments[0] &&
          ts.isObjectLiteralExpression(node.arguments[0])
        ) {
          const properties = new Map();
          for (const property of node.arguments[0].properties) {
            const key = propertyName(property, sourceFile);
            const value = ts.isPropertyAssignment(property)
              ? property.initializer
              : ts.isShorthandPropertyAssignment(property)
                ? property.name
                : undefined;
            if (key && value) properties.set(key, value);
          }
          definitions.push({ filePath, node, properties });
        }
        ts.forEachChild(node, walk);
      };
      walk(sourceFile);
    }
    return definitions;
  }

  return { lineOf, lookup, toolDefinitions, walkSchema };
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

/** Read every package `src` file, keyed by repo-relative path. */
export async function readRepoToolSources(repoRoot) {
  const packagesRoot = path.join(repoRoot, "packages");
  const files = {};
  const packageSrcRoots = {};
  for (const entry of await fs.readdir(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceRoot = path.join(packagesRoot, entry.name, "src");
    try {
      for (const filePath of await sourceFiles(sourceRoot)) {
        files[path.relative(repoRoot, filePath)] = await fs.readFile(
          filePath,
          "utf8",
        );
      }
      packageSrcRoots[entry.name] = path.relative(repoRoot, sourceRoot);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { files, packageSrcRoots };
}
