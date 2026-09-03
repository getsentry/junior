import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ALIAS_PREFIX = "@/";

function moduleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (ts.isImportTypeNode(node)) {
    const argument = node.argument;
    return ts.isLiteralTypeNode(argument) &&
      ts.isStringLiteral(argument.literal)
      ? argument.literal
      : undefined;
  }
  if (ts.isExternalModuleReference(node)) {
    return node.expression;
  }
  if (ts.isModuleDeclaration(node)) {
    return ts.isStringLiteral(node.name) ? node.name : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    return node.arguments[0];
  }
  return undefined;
}

function findInternalSpecifiers(sourceFile) {
  const specifiers = [];
  function visit(node) {
    const specifier = moduleSpecifier(node);
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      (specifier.text.startsWith(ALIAS_PREFIX) ||
        specifier.text.startsWith("./") ||
        specifier.text.startsWith("../"))
    ) {
      specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function resolveDeclarationTarget(distRoot, targetBase, sourceSpecifier) {
  const relativeTarget = path.relative(distRoot, targetBase);
  if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
    throw new Error(`declaration import escapes dist: ${sourceSpecifier}`);
  }

  const candidates = [
    `${targetBase}.d.ts`,
    path.join(targetBase, "index.d.ts"),
  ];
  const target = candidates.find((candidate) => existsSync(candidate));
  if (!target) {
    throw new Error(
      `declaration import has no emitted target: ${sourceSpecifier}`,
    );
  }
  return target;
}

function toRuntimeSpecifier(fromFile, targetDeclaration) {
  const target = targetDeclaration.endsWith(".d.ts")
    ? `${targetDeclaration.slice(0, -".d.ts".length)}.js`
    : targetDeclaration;
  let relative = path.relative(path.dirname(fromFile), target);
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative.split(path.sep).join("/");
}

/** Rewrite internal imports in one declaration without changing other strings. */
export function rewriteDeclarationText(source, fromFile, distRoot) {
  const sourceFile = ts.createSourceFile(
    fromFile,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edits = findInternalSpecifiers(sourceFile).flatMap((specifier) => {
    if (
      !specifier.text.startsWith(ALIAS_PREFIX) &&
      path.posix.extname(specifier.text)
    ) {
      return [];
    }
    const targetBase = specifier.text.startsWith(ALIAS_PREFIX)
      ? path.resolve(distRoot, specifier.text.slice(ALIAS_PREFIX.length))
      : path.resolve(path.dirname(fromFile), specifier.text);
    const target = resolveDeclarationTarget(
      distRoot,
      targetBase,
      specifier.text,
    );
    return [
      {
        start: specifier.getStart(sourceFile) + 1,
        end: specifier.getEnd() - 1,
        text: toRuntimeSpecifier(fromFile, target),
      },
    ];
  });

  let output = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  }
  return { output, rewrittenSpecifiers: edits.length };
}

async function listDeclarationFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDeclarationFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Rewrite every internal declaration import to a Node ESM-compatible path. */
export async function rewriteDeclarationPaths(distRoot) {
  let rewrittenFiles = 0;
  let rewrittenSpecifiers = 0;
  for (const filePath of await listDeclarationFiles(distRoot)) {
    const source = await fs.readFile(filePath, "utf8");
    const rewritten = rewriteDeclarationText(source, filePath, distRoot);
    if (rewritten.output !== source) {
      await fs.writeFile(filePath, rewritten.output);
      rewrittenFiles += 1;
      rewrittenSpecifiers += rewritten.rewrittenSpecifiers;
    }
  }
  return { rewrittenFiles, rewrittenSpecifiers };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const distRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist",
  );
  rewriteDeclarationPaths(distRoot)
    .then(({ rewrittenFiles, rewrittenSpecifiers }) => {
      console.log(
        `Rewrote ${rewrittenSpecifiers} declaration imports in ${rewrittenFiles} files.`,
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
