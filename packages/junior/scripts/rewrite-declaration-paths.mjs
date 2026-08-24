import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALIAS_PREFIX = "@/";
const SPECIFIER_PATTERN =
  /((?:from|import)\s*\(?\s*|export\s+(?:type\s+)?\{[^}]*\}\s*from\s*|export\s+\*\s+from\s*)(['"])@\/([^'"]+)\2/g;

/**
 * Rewrite one `@/` module specifier to a relative path from `fromFile`.
 * `distRoot` is the package declaration root that `@/` maps onto.
 */
export function rewriteAliasSpecifier(fromFile, distRoot, specifier) {
  if (!specifier.startsWith(ALIAS_PREFIX)) {
    return specifier;
  }

  const targetPath = path.resolve(distRoot, specifier.slice(ALIAS_PREFIX.length));
  let relativePath = path.relative(path.dirname(fromFile), targetPath);
  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }
  return relativePath.split(path.sep).join("/");
}

/** Rewrite every `@/` import/export specifier in one declaration file body. */
export function rewriteDeclarationSource(source, fromFile, distRoot) {
  return source.replace(
    SPECIFIER_PATTERN,
    (match, prefix, quote, aliasPath) => {
      const next = rewriteAliasSpecifier(
        fromFile,
        distRoot,
        `${ALIAS_PREFIX}${aliasPath}`,
      );
      return `${prefix}${quote}${next}${quote}`;
    },
  );
}

async function collectDeclarationFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
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

/** Rewrite `@/` aliases in every `.d.ts` file under `distRoot`. */
export async function rewriteDeclarationPaths(distRoot) {
  const files = await collectDeclarationFiles(distRoot);
  let rewrittenFiles = 0;
  let rewrittenSpecifiers = 0;
  const remaining = [];

  for (const filePath of files) {
    const original = await fs.readFile(filePath, "utf8");
    let fileSpecifiers = 0;
    const next = original.replace(
      SPECIFIER_PATTERN,
      (match, prefix, quote, aliasPath) => {
        fileSpecifiers += 1;
        const rewritten = rewriteAliasSpecifier(
          filePath,
          distRoot,
          `${ALIAS_PREFIX}${aliasPath}`,
        );
        return `${prefix}${quote}${rewritten}${quote}`;
      },
    );
    if (next !== original) {
      await fs.writeFile(filePath, next);
      rewrittenFiles += 1;
      rewrittenSpecifiers += fileSpecifiers;
    }

    const leftover = next.match(/['"]@\//g);
    if (leftover) {
      remaining.push(
        `${path.relative(distRoot, filePath)}: ${leftover.length} @/ specifier(s)`,
      );
    }
  }

  if (remaining.length > 0) {
    throw new Error(
      `declaration emit still contains @/ path aliases:\n${remaining.join("\n")}`,
    );
  }

  return { files: files.length, rewrittenFiles, rewrittenSpecifiers };
}

async function main() {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const distRoot = path.join(packageRoot, "dist");
  const result = await rewriteDeclarationPaths(distRoot);
  if (result.rewrittenSpecifiers === 0) {
    console.log("No @/ declaration imports to rewrite.");
    return;
  }
  console.log(
    `Rewrote ${result.rewrittenSpecifiers} @/ declaration imports across ${result.rewrittenFiles} files.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
