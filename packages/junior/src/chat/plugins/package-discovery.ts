import path from "node:path";
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
  if (!relative || path.isAbsolute(relative)) {
    return null;
  }

  const normalized = normalizeForGlob(relative);
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

let configuredPluginPackages: string[] | undefined;

/** Set the runtime plugin package allowlist. Called by `createApp()`. */
export function setPluginPackages(packages: string[] | undefined): void {
  configuredPluginPackages = packages;
}

function resolvePackageDirFromName(
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

  return null;
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
): InstalledJuniorContentPackage[] {
  const discovered: InstalledJuniorContentPackage[] = [];
  const seenPackageNames = new Set<string>();
  const seenPackageDirs = new Set<string>();

  for (const packageName of packageNames) {
    const resolved = resolvePackageDirFromName(
      packageName,
      candidateNodeModulesDirs,
    );
    if (!resolved) {
      continue;
    }

    if (
      seenPackageNames.has(packageName) ||
      seenPackageDirs.has(resolved.dir)
    ) {
      continue;
    }

    const pluginFlags = readPluginPackageFlags(resolved.dir);
    if (!pluginFlags) {
      continue;
    }

    seenPackageNames.add(packageName);
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
  const packageNames = options?.packageNames ?? configuredPluginPackages ?? [];
  const nodeModulesDirs =
    options?.nodeModulesDirs ?? discoverNodeModulesDirs(resolvedCwd);

  const discoveredPackages = discoverDeclaredPackages(
    packageNames,
    nodeModulesDirs,
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
