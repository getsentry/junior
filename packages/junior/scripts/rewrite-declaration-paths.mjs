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
  return undefined;
}

function needsRewrite(specifier) {
  if (specifier.startsWith(ALIAS_PREFIX)) {
    return true;
  }
  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  return isRelative && !path.posix.extname(specifier);
}

function findSpecifiersToRewrite(sourceFile) {
  const specifiers = [];
  function visit(node) {
    const specifier = moduleSpecifier(node);
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      needsRewrite(specifier.text)
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
    throw new Error(
      `declaration import points outside dist: ${sourceSpecifier}`,
    );
  }

  const target = `${targetBase}.d.ts`;
  if (!existsSync(target)) {
    throw new Error(
      `declaration import does not match an emitted file: ${sourceSpecifier}`,
    );
  }
  return target;
}

function toJsImport(fromFile, targetDeclaration) {
  const target = `${targetDeclaration.slice(0, -".d.ts".length)}.js`;
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
  const edits = findSpecifiersToRewrite(sourceFile).map((specifier) => {
    const targetBase = specifier.text.startsWith(ALIAS_PREFIX)
      ? path.resolve(distRoot, specifier.text.slice(ALIAS_PREFIX.length))
      : path.resolve(path.dirname(fromFile), specifier.text);
    const target = resolveDeclarationTarget(
      distRoot,
      targetBase,
      specifier.text,
    );
    return {
      start: specifier.getStart(sourceFile) + 1,
      end: specifier.getEnd() - 1,
      text: toJsImport(fromFile, target),
    };
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
