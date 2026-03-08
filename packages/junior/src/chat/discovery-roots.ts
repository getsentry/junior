import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    const normalized = normalizePath(value);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }
  return resolved;
}

function isNodeModulesPath(candidatePath: string): boolean {
  return path.basename(candidatePath) === "node_modules";
}

function isInsidePnpmStore(candidatePath: string): boolean {
  return candidatePath.split(path.sep).includes(".pnpm");
}

function runningFromInstalledPackage(): boolean {
  const currentFile = fileURLToPath(import.meta.url);
  const marker = `${path.sep}node_modules${path.sep}@sentry${path.sep}junior${path.sep}`;
  return currentFile.includes(marker);
}

function listInstalledPackageNodeModulesDirs(): string[] {
  if (!runningFromInstalledPackage()) {
    return [];
  }

  const dirs: string[] = [];
  let current = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

  while (true) {
    if (isNodeModulesPath(current) && !isInsidePnpmStore(current) && isDirectory(current)) {
      dirs.push(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
}

function listCwdAncestorNodeModulesDirs(cwd: string): string[] {
  const resolvedCwd = normalizePath(cwd);
  const dirs: string[] = [];
  let current = resolvedCwd;

  while (true) {
    const nodeModulesDir = path.join(current, "node_modules");
    if (isDirectory(nodeModulesDir)) {
      dirs.push(nodeModulesDir);
    }

    if (isFile(path.join(current, "package.json"))) {
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return dirs;
}

export interface DiscoverNodeModulesDirsOptions {
  candidateDirs?: string[];
}

export function discoverNodeModulesDirs(
  cwd: string = process.cwd(),
  options?: DiscoverNodeModulesDirsOptions
): string[] {
  const explicit = options?.candidateDirs?.filter((dir) => isDirectory(dir)) ?? [];
  if (explicit.length > 0) {
    return uniqueInOrder(explicit);
  }

  return uniqueInOrder([
    ...listInstalledPackageNodeModulesDirs(),
    ...listCwdAncestorNodeModulesDirs(cwd)
  ]);
}

export interface DiscoverProjectRootsOptions {
  nodeModulesDirs?: string[];
}

export function discoverProjectRoots(
  cwd: string = process.cwd(),
  options?: DiscoverProjectRootsOptions
): string[] {
  const roots = discoverNodeModulesDirs(cwd, options?.nodeModulesDirs ? { candidateDirs: options.nodeModulesDirs } : undefined)
    .map((nodeModulesDir) => path.dirname(nodeModulesDir));

  return uniqueInOrder([cwd, ...roots]);
}

export function listTopLevelPackages(nodeModulesDir: string): Array<{ name: string; dir: string }> {
  const entries = readdirSync(nodeModulesDir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith(".") && entry.name !== ".bin" && entry.name !== ".pnpm")
    .sort((left, right) => left.name.localeCompare(right.name));

  const packages: Array<{ name: string; dir: string }> = [];
  for (const entry of entries) {
    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@")) {
      if (!isDirectory(entryPath)) {
        continue;
      }

      const scopedEntries = readdirSync(entryPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name)
      );
      for (const scopedEntry of scopedEntries) {
        const packageName = `${entry.name}/${scopedEntry.name}`;
        const packagePath = path.join(entryPath, scopedEntry.name);
        if (!isDirectory(packagePath)) {
          continue;
        }
        packages.push({ name: packageName, dir: packagePath });
      }
      continue;
    }

    if (!isDirectory(entryPath)) {
      continue;
    }
    packages.push({ name: entry.name, dir: entryPath });
  }

  return packages;
}
