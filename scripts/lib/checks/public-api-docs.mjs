import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const requireFromJunior = createRequire(
  path.join(root, "packages/junior/package.json"),
);
const ts = requireFromJunior("typescript");
const baselinePath = "scripts/lib/checks/public-api-docs-baseline.json";

const CHECKED_KINDS = new Set([
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
]);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function normalizeRelativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function resolveSourceEntrypoint(packageDir, exportedTypesPath) {
  if (typeof exportedTypesPath !== "string") {
    return null;
  }

  const withoutDot = exportedTypesPath.replace(/^\.\//, "");

  if (withoutDot.endsWith(".d.ts")) {
    if (!withoutDot.startsWith("dist/")) {
      const relativePath = `${packageDir}/${withoutDot}`;
      return exists(relativePath) ? relativePath : null;
    }

    const sourcePath = `src/${withoutDot.slice("dist/".length, -".d.ts".length)}.ts`;
    const relativePath = `${packageDir}/${sourcePath}`;
    return exists(relativePath) ? relativePath : null;
  }

  if (!withoutDot.endsWith(".ts") || !withoutDot.startsWith("src/")) {
    return null;
  }

  const relativePath = `${packageDir}/${withoutDot}`;
  return exists(relativePath) ? relativePath : null;
}

function exportedTypesPaths(exportsField) {
  if (!exportsField) {
    return [];
  }

  if (typeof exportsField === "string") {
    return [exportsField];
  }

  if (typeof exportsField.types === "string") {
    return [exportsField.types];
  }

  return Object.values(exportsField).flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }

    if (entry && typeof entry === "object" && typeof entry.types === "string") {
      return [entry.types];
    }

    return [];
  });
}

function collectEntrypoints() {
  const packagesDir = path.join(root, "packages");

  return fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageDir = `packages/${entry.name}`;
      const packageJsonPath = `${packageDir}/package.json`;

      if (!exists(packageJsonPath)) {
        return [];
      }

      const packageJson = readJson(packageJsonPath);

      if (packageJson.private === true) {
        return [];
      }

      return exportedTypesPaths(packageJson.exports)
        .map((typesPath) => resolveSourceEntrypoint(packageDir, typesPath))
        .filter((entrypoint) => entrypoint !== null);
    })
    .filter((entrypoint, index, entrypoints) => {
      return entrypoints.indexOf(entrypoint) === index;
    })
    .sort();
}

const sourceFileCache = new Map();

function readSourceFile(filePath) {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(root, filePath);
  const normalizedPath = normalizeRelativePath(absolutePath);
  const cached = sourceFileCache.get(normalizedPath);

  if (cached) {
    return cached;
  }

  const sourceFile = ts.createSourceFile(
    absolutePath,
    fs.readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  sourceFileCache.set(normalizedPath, sourceFile);
  return sourceFile;
}

function hasExportModifier(node) {
  return Boolean(
    node.modifiers?.some((modifier) => {
      return modifier.kind === ts.SyntaxKind.ExportKeyword;
    }),
  );
}

function declarationName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  return null;
}

function isCheckedDeclaration(node) {
  return CHECKED_KINDS.has(node.kind);
}

function declarationHasJSDoc(node) {
  return ts.getJSDocCommentsAndTags(node).some((commentOrTag) => {
    const comment =
      "comment" in commentOrTag && typeof commentOrTag.comment === "string"
        ? commentOrTag.comment.trim()
        : "";

    return comment.length > 0 || ts.isJSDoc(commentOrTag);
  });
}

function collectLocalDeclarations(sourceFile) {
  const declarations = new Map();

  for (const statement of sourceFile.statements) {
    if (!isCheckedDeclaration(statement)) {
      continue;
    }

    const name = declarationName(statement);

    if (name) {
      declarations.set(name, statement);
    }
  }

  return declarations;
}

function resolveModuleSpecifier(sourceFile, moduleSpecifier) {
  if (!moduleSpecifier.startsWith(".")) {
    return null;
  }

  const sourceDir = path.dirname(sourceFile.fileName);
  const targetBase = path.resolve(sourceDir, moduleSpecifier);
  const candidates = [
    `${targetBase}.ts`,
    `${targetBase}.tsx`,
    path.join(targetBase, "index.ts"),
    path.join(targetBase, "index.tsx"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return normalizeRelativePath(candidate);
    }
  }

  return null;
}

function exportNameFromDeclaration(statement) {
  if (
    statement.modifiers?.some((modifier) => {
      return modifier.kind === ts.SyntaxKind.DefaultKeyword;
    })
  ) {
    return "default";
  }

  return declarationName(statement);
}

function buildExportMap(relativePath, seen = new Set()) {
  const sourceFile = readSourceFile(relativePath);
  const normalizedPath = normalizeRelativePath(sourceFile.fileName);

  if (seen.has(normalizedPath)) {
    return new Map();
  }

  seen.add(normalizedPath);

  const localDeclarations = collectLocalDeclarations(sourceFile);
  const exports = new Map();

  for (const statement of sourceFile.statements) {
    if (isCheckedDeclaration(statement) && hasExportModifier(statement)) {
      const exportName = exportNameFromDeclaration(statement);

      if (exportName) {
        exports.set(exportName, {
          declaration: statement,
          sourceFile,
          exportName,
        });
      }

      continue;
    }

    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    const modulePath = statement.moduleSpecifier
      ? resolveModuleSpecifier(sourceFile, statement.moduleSpecifier.text)
      : normalizedPath;
    const sourceExports =
      modulePath === normalizedPath
        ? new Map(
            [...localDeclarations].map(([name, declaration]) => [
              name,
              { declaration, sourceFile, exportName: name },
            ]),
          )
        : modulePath
          ? buildExportMap(modulePath, seen)
          : new Map();

    if (!statement.exportClause) {
      for (const [name, declaration] of sourceExports) {
        exports.set(name, declaration);
      }

      continue;
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      const localName = element.propertyName?.text ?? element.name.text;
      const exportedName = element.name.text;
      const exportedDeclaration = sourceExports.get(localName);

      if (exportedDeclaration) {
        exports.set(exportedName, {
          ...exportedDeclaration,
          exportName: exportedName,
        });
      }
    }
  }

  seen.delete(normalizedPath);
  return exports;
}

function lineAndColumn(sourceFile, node) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return {
    line: position.line + 1,
    column: position.character + 1,
  };
}

export function runPublicApiDocsCheck() {
  const entrypoints = collectEntrypoints();
  const failures = [];
  const checkedDeclarations = new Set();
  const currentMissingDocs = new Set();
  const baseline = exists(baselinePath)
    ? new Set(readJson(baselinePath))
    : new Set();

  for (const entrypoint of entrypoints) {
    for (const declarationInfo of buildExportMap(entrypoint).values()) {
      const sourcePath = normalizeRelativePath(
        declarationInfo.sourceFile.fileName,
      );
      const name = declarationName(declarationInfo.declaration);

      if (!name) {
        continue;
      }

      const key = `${sourcePath}:${declarationInfo.declaration.pos}:${name}`;

      if (checkedDeclarations.has(key)) {
        continue;
      }

      checkedDeclarations.add(key);

      const baselineKey = `${sourcePath}:${name}:${ts.SyntaxKind[declarationInfo.declaration.kind]}`;

      if (declarationHasJSDoc(declarationInfo.declaration)) {
        continue;
      }

      currentMissingDocs.add(baselineKey);

      if (baseline.has(baselineKey)) {
        continue;
      }

      const location = lineAndColumn(
        declarationInfo.sourceFile,
        declarationInfo.declaration,
      );

      failures.push({
        kind: ts.SyntaxKind[declarationInfo.declaration.kind],
        line: location.line,
        name,
        sourcePath,
      });
    }
  }

  const staleBaseline = [...baseline].filter((entry) => {
    return !currentMissingDocs.has(entry);
  });

  if (process.env.UPDATE_PUBLIC_API_DOCS_BASELINE === "1") {
    fs.writeFileSync(
      path.join(root, baselinePath),
      `${JSON.stringify([...currentMissingDocs].sort(), null, 2)}\n`,
    );
    return {
      ok: true,
      summary: `updated ${baselinePath}: ${currentMissingDocs.size} missing public API docs baselined`,
    };
  }

  if (failures.length > 0 || staleBaseline.length > 0) {
    const details = [];

    for (const failure of failures) {
      details.push(
        `${failure.sourcePath}:${failure.line} ${failure.name} (${failure.kind}) needs a JSDoc comment.`,
      );
    }

    for (const entry of staleBaseline) {
      details.push(
        `${baselinePath} has stale entry ${entry}. Remove it from the baseline.`,
      );
    }

    details.push(
      "Add brief JSDoc explaining public API intent, not a restatement of the declaration.",
    );

    return {
      ok: false,
      details,
    };
  }

  return {
    ok: true,
    summary: `checked ${checkedDeclarations.size} declarations from ${entrypoints.length} entrypoints (${baseline.size} baselined)`,
  };
}
