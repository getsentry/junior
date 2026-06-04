import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { globToRegex } from "@/build/glob-to-regex";
import { isValidPackageName, resolvePackageDir } from "@/package-resolution";

/** Copy extra file patterns into server output for files the bundler cannot trace. */
export function copyIncludedFiles(
  cwd: string,
  serverRoot: string,
  patterns?: unknown,
): void {
  if (patterns === undefined) return;
  if (!Array.isArray(patterns)) {
    throw new Error(
      "includeFiles must be an array of package subpath patterns",
    );
  }
  if (patterns.length === 0) return;

  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern.trim()) {
      throw new Error("includeFiles entries must be package subpath patterns");
    }
    const { pkgName, subDir, fileGlob } = parseIncludePattern(pattern);

    const pkgDir = resolvePackageDir(cwd, pkgName);
    if (!pkgDir) {
      throw new Error(
        `includeFiles entry "${pattern}" references package "${pkgName}", but it could not be resolved`,
      );
    }

    const sourceDir = path.join(pkgDir, subDir);
    if (!isDirectory(sourceDir)) {
      throw new Error(
        `includeFiles entry "${pattern}" references missing directory ${sourceDir}`,
      );
    }

    const entries = readdirSync(sourceDir);
    const re = fileGlob.includes("*") ? globToRegex(fileGlob) : null;
    let matched = false;
    let copied = false;

    for (const entry of entries) {
      if (re ? !re.test(entry) : entry !== fileGlob) continue;
      matched = true;
      copied =
        copyIfExists(
          path.join(sourceDir, entry),
          path.join(serverRoot, "node_modules", pkgName, subDir, entry),
        ) || copied;
    }

    if (!matched) {
      throw new Error(
        `includeFiles entry "${pattern}" did not match any files in ${sourceDir}`,
      );
    }
    if (!copied) {
      throw new Error(
        `includeFiles entry "${pattern}" matched files in ${sourceDir} but did not copy any existing files`,
      );
    }
  }
}

function parseIncludePattern(pattern: string): {
  fileGlob: string;
  pkgName: string;
  subDir: string;
} {
  const normalized = pattern.trim().replace(/^node_modules\//, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      `includeFiles entry "${pattern}" must be a package subpath pattern`,
    );
  }

  const isScopedPackage = parts[0].startsWith("@");
  const packagePartCount = isScopedPackage ? 2 : 1;
  const pkgName = parts.slice(0, packagePartCount).join("/");
  const subpath = parts.slice(packagePartCount).join("/");
  if (!pkgName || !isValidPackageName(pkgName) || !subpath) {
    throw new Error(
      `includeFiles entry "${pattern}" must include a package subpath`,
    );
  }

  return {
    pkgName,
    subDir: path.dirname(subpath),
    fileGlob: path.basename(subpath),
  };
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function copyIfExists(source: string, target: string): boolean {
  if (!existsSync(source)) {
    return false;
  }

  mkdirSync(path.dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
  return true;
}
