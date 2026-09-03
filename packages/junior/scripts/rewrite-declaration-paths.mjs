import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const ALIAS_RE = /(["'])@\/([^"']+)\1/g;

/** Convert a source `@/` alias to a path under the declaration output root. */
export function resolveAliasTarget(distDirectory, aliasPath) {
  return path.join(distDirectory, aliasPath);
}

/** Rewrite one `@/` import/export specifier to a relative declaration path. */
export function rewriteAliasSpecifier(fromFile, distDirectory, aliasPath) {
  const target = resolveAliasTarget(distDirectory, aliasPath);
  let relative = path.relative(path.dirname(fromFile), target).replaceAll("\\", "/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative;
}

/** Rewrite every `@/` path alias inside one declaration file. */
export function rewriteDeclarationSource(fromFile, distDirectory, source) {
  return source.replace(ALIAS_RE, (_match, quote, aliasPath) => {
    return `${quote}${rewriteAliasSpecifier(fromFile, distDirectory, aliasPath)}${quote}`;
  });
}

async function collectDeclarationFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectDeclarationFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

/** Rewrite `@/` aliases across every declaration file under dist/. */
export async function rewriteDeclarationPaths(options = {}) {
  const root = options.distRoot ?? distRoot;
  const files = await collectDeclarationFiles(root);
  let rewrittenFiles = 0;
  let rewrittenSpecifiers = 0;

  for (const file of files) {
    const original = await fs.readFile(file, "utf8");
    let fileRewrites = 0;
    const next = original.replace(ALIAS_RE, (_match, quote, aliasPath) => {
      fileRewrites += 1;
      return `${quote}${rewriteAliasSpecifier(file, root, aliasPath)}${quote}`;
    });
    if (fileRewrites === 0) {
      continue;
    }
    rewrittenFiles += 1;
    rewrittenSpecifiers += fileRewrites;
    await fs.writeFile(file, next);
  }

  return { files: files.length, rewrittenFiles, rewrittenSpecifiers };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await rewriteDeclarationPaths();
  console.log(
    `rewrote ${result.rewrittenSpecifiers} @/ declaration paths across ${result.rewrittenFiles}/${result.files} files`,
  );
}
