import { statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface ResolvedPackageLocation {
  dir: string;
  nodeModulesDir?: string;
}

export interface ResolvePackageLocationOptions {
  nodeModulesDirs?: string[];
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function uniqueResolvedPathsInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    const normalized = path.resolve(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }
  return resolved;
}

function ancestorNodeModulesDirs(cwd: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(cwd);

  while (true) {
    const nodeModulesDir = path.join(current, "node_modules");
    if (isDirectory(nodeModulesDir)) {
      dirs.push(nodeModulesDir);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
}

function packageDirInNodeModules(
  nodeModulesDir: string,
  packageName: string,
): string | undefined {
  const packageDir = path.join(nodeModulesDir, ...packageName.split("/"));
  return isDirectory(packageDir) ? path.resolve(packageDir) : undefined;
}

function isValidPackageSegment(segment: string): boolean {
  return (
    Boolean(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.startsWith(".") &&
    /^[A-Za-z0-9._~-]+$/.test(segment)
  );
}

/** Return whether a string is shaped like an npm package name. */
export function isValidPackageName(packageName: string): boolean {
  if (
    !packageName ||
    packageName.includes("\\") ||
    path.isAbsolute(packageName)
  ) {
    return false;
  }

  const parts = packageName.split("/");
  if (parts[0].startsWith("@")) {
    return (
      parts.length === 2 &&
      parts[0].length > 1 &&
      isValidPackageSegment(parts[0].slice(1)) &&
      isValidPackageSegment(parts[1])
    );
  }

  return parts.length === 1 && isValidPackageSegment(parts[0]);
}

function findPackageRoot(entryPath: string): string | undefined {
  let dir = path.dirname(entryPath);
  while (dir !== path.dirname(dir)) {
    if (isFile(path.join(dir, "package.json"))) {
      return path.resolve(dir);
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function findPackageNodeModulesDir(
  packageDir: string,
  packageName: string,
): string | undefined {
  const parts = path.resolve(packageDir).split(path.sep);
  const packageParts = packageName.split("/");

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index] !== "node_modules") {
      continue;
    }
    const candidatePackageParts = parts.slice(
      index + 1,
      index + 1 + packageParts.length,
    );
    if (candidatePackageParts.join("/") !== packageParts.join("/")) {
      continue;
    }
    return path.resolve(parts.slice(0, index + 1).join(path.sep) || path.sep);
  }

  return undefined;
}

function resolvePackageWithNode(
  cwd: string,
  packageName: string,
): ResolvedPackageLocation | undefined {
  let requireFromCwd: NodeJS.Require;
  try {
    requireFromCwd = createRequire(path.join(cwd, "package.json"));
  } catch {
    return undefined;
  }

  for (const specifier of [`${packageName}/package.json`, packageName]) {
    try {
      const resolved = requireFromCwd.resolve(specifier);
      const dir = specifier.endsWith("/package.json")
        ? path.dirname(resolved)
        : findPackageRoot(resolved);
      if (!dir) {
        continue;
      }
      const nodeModulesDir = findPackageNodeModulesDir(dir, packageName);
      return {
        dir,
        ...(nodeModulesDir ? { nodeModulesDir } : {}),
      };
    } catch {
      // Try the next Node resolution form.
    }
  }

  return undefined;
}

/** Resolve a package root from an app cwd without requiring the package to expose a JS entry point. */
export function resolvePackageLocation(
  cwd: string,
  packageName: string,
  options?: ResolvePackageLocationOptions,
): ResolvedPackageLocation | undefined {
  if (!isValidPackageName(packageName)) {
    return undefined;
  }

  const nodeModulesDirs = uniqueResolvedPathsInOrder([
    ...(options?.nodeModulesDirs ?? []),
    ...ancestorNodeModulesDirs(cwd),
  ]);

  for (const nodeModulesDir of nodeModulesDirs) {
    const dir = packageDirInNodeModules(nodeModulesDir, packageName);
    if (dir) {
      return { dir, nodeModulesDir };
    }
  }

  return resolvePackageWithNode(cwd, packageName);
}

/** Resolve a package root directory from an app cwd. */
export function resolvePackageDir(
  cwd: string,
  packageName: string,
): string | undefined {
  return resolvePackageLocation(cwd, packageName)?.dir;
}
