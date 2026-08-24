import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Turn one `@/…` import into a relative path from `fromFile` under `distRoot`. */
export function toRelativeImport(fromFile, distRoot, aliasPath) {
  const target = path.resolve(distRoot, aliasPath);
  let relative = path.relative(path.dirname(fromFile), target);
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return relative.split(path.sep).join("/");
}

/** Replace `@/…` imports in one `.d.ts` file body. */
export function rewriteDeclarationText(source, fromFile, distRoot) {
  return source.replace(/(['"])@\/([^'"]+)\1/g, (match, quote, aliasPath) => {
    return `${quote}${toRelativeImport(fromFile, distRoot, aliasPath)}${quote}`;
  });
}

async function listDtsFiles(dir) {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listDtsFiles(fullPath)));
    } else if (entry.name.endsWith(".d.ts")) {
      out.push(fullPath);
    }
  }
  return out;
}

/** Rewrite every `@/` import under `dist/` so published types resolve for apps. */
export async function rewriteDeclarationPaths(distRoot) {
  const leftovers = [];
  for (const filePath of await listDtsFiles(distRoot)) {
    const before = await fs.readFile(filePath, "utf8");
    const after = rewriteDeclarationText(before, filePath, distRoot);
    if (after !== before) {
      await fs.writeFile(filePath, after);
    }
    if (after.includes("'@/") || after.includes('"@/')) {
      leftovers.push(path.relative(distRoot, filePath));
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      `still have @/ imports in published types:\n${leftovers.join("\n")}`,
    );
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const distRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../dist",
  );
  rewriteDeclarationPaths(distRoot).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
