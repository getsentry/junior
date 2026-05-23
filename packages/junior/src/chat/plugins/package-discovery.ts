import path from "node:path";
import { createRequire } from "node:module";
import { discoverNodeModulesDirs, isDirectory, isFile } from "@/chat/discovery";

interface InstalledJuniorContentPackage {
  name: string;
  dir: string;
  nodeModulesDir: string | null;
  hasRootPluginManifest: boolean;
  hasPluginsDir: boolean;
  hasSkillsDir: boolean;
}

export interface InstalledPluginPackageContent {
  packageNames: string[];
  manifestRoots: string[];
  skillRoots: string[];
  tracingIncludes: string[];
}

function normalizeForGlob(targetPath: string): string {
  return targetPath.split(path.sep).join("/");
}

function uniqueStringsInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    resolved.push(value);
  }
  return resolved;
}

function pathForTracingInclude(cwd: string, targetPath: string): string | null {
  const relative = path.relative(cwd, targetPath);
  if (
    !relative ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    return null;
  }

  const normalized = normalizeForGlob(relative);
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

let configuredPluginPackages: string[] | undefined;

/** Set the runtime plugin package allowlist. Called by `createApp()`. */
export function setPluginPackages(packages: string[] | undefined): void {
  configuredPluginPackages = normalizePackageNames(packages);
}

function normalizePackageNames(packageNames: string[] | undefined): string[] {
  if (!packageNames) {
    return [];
  }

  const normalized: string[] = [];
  for (const packageName of packageNames) {
    if (typeof packageName !== "string" || !packageName.trim()) {
      throw new Error("Plugin package names must be non-empty strings");
    }
    normalized.push(packageName.trim());
  }
  return normalized;
}

function formatNodeModulesDirs(candidateNodeModulesDirs: string[]): string {
  return candidateNodeModulesDirs.length > 0
    ? candidateNodeModulesDirs.join(", ")
    : "none found";
}

function resolvePackageDirFromName(
  cwd: string,
  packageName: string,
  candidateNodeModulesDirs: string[],
): { dir: string; nodeModulesDir: string } | null {
  for (const nodeModulesDir of candidateNodeModulesDirs) {
    const packageDir = path.join(nodeModulesDir, ...packageName.split("/"));
    if (isDirectory(packageDir)) {
      return {
        dir: path.resolve(packageDir),
        nodeModulesDir: path.resolve(nodeModulesDir),
      };
    }
  }

  return resolvePackageDirFromNode(packageName, cwd);
}

function findPackageRoot(entryPath: string): string | null {
  let dir = path.dirname(entryPath);
  while (dir !== path.dirname(dir)) {
    if (isFile(path.join(dir, "package.json"))) {
      return path.resolve(dir);
    }
    dir = path.dirname(dir);
  }
  return null;
}

function findPackageNodeModulesDir(
  packageDir: string,
  packageName: string,
): string | null {
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

  return null;
}

function resolvePackageDirFromNode(
  packageName: string,
  cwd: string,
): { dir: string; nodeModulesDir: string } | null {
  try {
    const requireFromCwd = createRequire(path.join(cwd, "package.json"));
    const entry = requireFromCwd.resolve(packageName);
    const dir = findPackageRoot(entry);
    const nodeModulesDir = dir
      ? findPackageNodeModulesDir(dir, packageName)
      : null;
    if (!dir || !nodeModulesDir) {
      return null;
    }
    return { dir, nodeModulesDir };
  } catch {
    return null;
  }
}

function readPluginPackageFlags(dir: string): {
  hasRootPluginManifest: boolean;
  hasPluginsDir: boolean;
  hasSkillsDir: boolean;
} | null {
  const hasRootPluginManifest = isFile(path.join(dir, "plugin.yaml"));
  const hasPluginsDir = isDirectory(path.join(dir, "plugins"));
  const hasSkillsDir = isDirectory(path.join(dir, "skills"));
  if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
    return null;
  }

  return {
    hasRootPluginManifest,
    hasPluginsDir,
    hasSkillsDir,
  };
}

function discoverDeclaredPackages(
  packageNames: string[],
  candidateNodeModulesDirs: string[],
  cwd: string,
): InstalledJuniorContentPackage[] {
  const discovered: InstalledJuniorContentPackage[] = [];
  const seenPackageDirs = new Set<string>();

  for (const packageName of uniqueStringsInOrder(packageNames)) {
    const resolved = resolvePackageDirFromName(
      cwd,
      packageName,
      candidateNodeModulesDirs,
    );
    if (!resolved) {
      throw new Error(
        `Plugin package "${packageName}" was configured but could not be resolved from node_modules or package resolution (${formatNodeModulesDirs(candidateNodeModulesDirs)})`,
      );
    }

    if (seenPackageDirs.has(resolved.dir)) {
      continue;
    }

    const pluginFlags = readPluginPackageFlags(resolved.dir);
    if (!pluginFlags) {
      throw new Error(
        `Plugin package "${packageName}" was configured but does not contain plugin content; expected plugin.yaml, plugins/, or skills/ in ${resolved.dir}`,
      );
    }

    seenPackageDirs.add(resolved.dir);
    discovered.push({
      name: packageName,
      dir: resolved.dir,
      nodeModulesDir: resolved.nodeModulesDir,
      ...pluginFlags,
    });
  }

  return discovered;
}

export interface DiscoverInstalledPluginPackageContentOptions {
  nodeModulesDirs?: string[];
  packageNames?: string[];
}

/** Discover plugin package content from explicitly declared package names. */
export function discoverInstalledPluginPackageContent(
  cwd: string = process.cwd(),
  options?: DiscoverInstalledPluginPackageContentOptions,
): InstalledPluginPackageContent {
  const resolvedCwd = path.resolve(cwd);
  const packageNames = normalizePackageNames(
    options?.packageNames ?? configuredPluginPackages,
  );
  const nodeModulesDirs =
    options?.nodeModulesDirs ?? discoverNodeModulesDirs(resolvedCwd);

  const discoveredPackages = discoverDeclaredPackages(
    packageNames,
    nodeModulesDirs,
    resolvedCwd,
  );

  const manifestRoots: string[] = [];
  const skillRoots: string[] = [];
  const tracingIncludes: string[] = [];

  for (const pkg of discoveredPackages) {
    const tracingBasePath = pkg.nodeModulesDir
      ? pathForTracingInclude(
          resolvedCwd,
          path.join(pkg.nodeModulesDir, ...pkg.name.split("/")),
        )
      : pathForTracingInclude(resolvedCwd, pkg.dir);
    if (pkg.hasRootPluginManifest) {
      manifestRoots.push(pkg.dir);
      if (tracingBasePath) {
        tracingIncludes.push(`${tracingBasePath}/plugin.yaml`);
      }
    }
    if (pkg.hasPluginsDir) {
      manifestRoots.push(path.join(pkg.dir, "plugins"));
      if (tracingBasePath) {
        tracingIncludes.push(`${tracingBasePath}/plugins/**/*`);
      }
    }
    if (pkg.hasSkillsDir) {
      skillRoots.push(path.join(pkg.dir, "skills"));
      if (tracingBasePath) {
        tracingIncludes.push(`${tracingBasePath}/skills/**/*`);
      }
    }
  }

  return {
    packageNames: uniqueStringsInOrder(
      discoveredPackages.map((pkg) => pkg.name),
    ),
    manifestRoots: uniqueStringsInOrder(manifestRoots),
    skillRoots: uniqueStringsInOrder(skillRoots),
    tracingIncludes: uniqueStringsInOrder(tracingIncludes),
  };
}
