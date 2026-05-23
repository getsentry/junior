import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";
import { globToRegex } from "@/build/glob-to-regex";
import { isValidPackageName, resolvePackageDir } from "@/package-resolution";

/** Copy app directory and plugin manifests into the server output. */
export function copyAppAndPluginContent(
  cwd: string,
  serverRoot: string,
  packageNames?: unknown,
): void {
  copyIfExists(path.join(cwd, "app"), path.join(serverRoot, "app"));

  const packagedContent = discoverInstalledPluginPackageContent(cwd, {
    packageNames,
  });
  for (const root of packagedContent.manifestRoots) {
    if (existsSync(path.join(root, "plugin.yaml"))) {
      const manifestPath = path.join(root, "plugin.yaml");
      copyIfExists(
        manifestPath,
        resolveServerOutputPath(cwd, serverRoot, manifestPath),
      );
      continue;
    }

    copyRootIntoServerOutput(cwd, serverRoot, root);
  }

  for (const root of packagedContent.skillRoots) {
    copyRootIntoServerOutput(cwd, serverRoot, root);
  }
}

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

function copyRootIntoServerOutput(
  cwd: string,
  serverRoot: string,
  root: string,
): void {
  copyIfExists(root, resolveServerOutputPath(cwd, serverRoot, root));
}

function resolveServerOutputPath(
  cwd: string,
  serverRoot: string,
  sourcePath: string,
): string {
  const relative = path.relative(cwd, sourcePath);
  if (isLocalRelativePath(relative)) {
    return path.join(serverRoot, relative);
  }

  const nodeModulesRelative = nodeModulesRelativePath(sourcePath);
  if (nodeModulesRelative) {
    return path.join(serverRoot, nodeModulesRelative);
  }

  throw new Error(
    `Cannot copy configured plugin content outside the app root or node_modules: ${sourcePath}`,
  );
}

function isLocalRelativePath(relativePath: string): boolean {
  return (
    Boolean(relativePath) &&
    !path.isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`)
  );
}

function nodeModulesRelativePath(sourcePath: string): string | null {
  const parts = path.resolve(sourcePath).split(path.sep);
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex === parts.length - 1) {
    return null;
  }

  return path.join("node_modules", ...parts.slice(nodeModulesIndex + 1));
}
