import path from "node:path";
import {
  discoverNodeModulesDirs,
  listTopLevelPackages,
} from "@/chat/discovery-roots";
import { isDirectory, isFile } from "@/chat/fs-utils";

const JUNIOR_PLUGIN_PACKAGES_ENV = "JUNIOR_PLUGIN_PACKAGES";

interface InstalledJuniorContentPackage {
  name: string;
  dir: string;
  nodeModulesDir: string;
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

function pathWithinCwd(cwd: string, targetPath: string): string | null {
  const relative = path.relative(cwd, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return `./${normalizeForGlob(relative)}`;
}

function parseRuntimeConfiguredPackageNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const parsed = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  return uniqueStringsInOrder(parsed.map((entry) => entry.trim()));
}

function readNextRuntimeConfiguredPackageNames(): string[] | null {
  const raw = process.env[JUNIOR_PLUGIN_PACKAGES_ENV];
  if (raw === undefined) {
    return null;
  }
  try {
    return parseRuntimeConfiguredPackageNames(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
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

    const hasRootPluginManifest = isFile(
      path.join(resolved.dir, "plugin.yaml"),
    );
    const hasPluginsDir = isDirectory(path.join(resolved.dir, "plugins"));
    const hasSkillsDir = isDirectory(path.join(resolved.dir, "skills"));
    if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
      continue;
    }

    seenPackageNames.add(packageName);
    seenPackageDirs.add(resolved.dir);
    discovered.push({
      name: packageName,
      dir: resolved.dir,
      nodeModulesDir: resolved.nodeModulesDir,
      hasRootPluginManifest,
      hasPluginsDir,
      hasSkillsDir,
    });
  }

  return discovered;
}

function discoverInstalledJuniorContentPackages(
  cwd: string = process.cwd(),
  nodeModulesDirs?: string[],
  packageNames?: string[],
): InstalledJuniorContentPackage[] {
  const resolvedCwd = path.resolve(cwd);
  const candidateNodeModulesDirs =
    nodeModulesDirs ?? discoverNodeModulesDirs(resolvedCwd);
  const configuredPackageNames =
    packageNames ?? readNextRuntimeConfiguredPackageNames();
  const declaredPackages = discoverDeclaredPackages(
    configuredPackageNames ?? [],
    candidateNodeModulesDirs,
  );
  const useFallbackScan = configuredPackageNames === null;
  const discovered: InstalledJuniorContentPackage[] = [...declaredPackages];
  const seenPackageNames = new Set<string>();
  const seenPackageDirs = new Set<string>();
  for (const pkg of declaredPackages) {
    seenPackageNames.add(pkg.name);
    seenPackageDirs.add(pkg.dir);
  }

  if (!useFallbackScan) {
    return discovered;
  }

  for (const nodeModulesDir of candidateNodeModulesDirs) {
    for (const pkg of listTopLevelPackages(nodeModulesDir)) {
      const resolvedDir = path.resolve(pkg.dir);
      if (seenPackageNames.has(pkg.name) || seenPackageDirs.has(resolvedDir)) {
        continue;
      }
      seenPackageNames.add(pkg.name);
      seenPackageDirs.add(resolvedDir);

      const hasRootPluginManifest = isFile(
        path.join(resolvedDir, "plugin.yaml"),
      );
      const hasPluginsDir = isDirectory(path.join(resolvedDir, "plugins"));
      const hasSkillsDir = isDirectory(path.join(resolvedDir, "skills"));
      if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
        continue;
      }

      discovered.push({
        name: pkg.name,
        dir: resolvedDir,
        nodeModulesDir: path.resolve(nodeModulesDir),
        hasRootPluginManifest,
        hasPluginsDir,
        hasSkillsDir,
      });
    }
  }

  return discovered;
}

export interface DiscoverInstalledPluginPackageContentOptions {
  nodeModulesDirs?: string[];
  packageNames?: string[];
}

export function discoverInstalledPluginPackageContent(
  cwd: string = process.cwd(),
  options?: DiscoverInstalledPluginPackageContentOptions,
): InstalledPluginPackageContent {
  const resolvedCwd = path.resolve(cwd);
  const discoveredPackages = discoverInstalledJuniorContentPackages(
    resolvedCwd,
    options?.nodeModulesDirs,
    options?.packageNames,
  );
  const manifestRoots: string[] = [];
  const skillRoots: string[] = [];
  const tracingIncludes: string[] = [];

  for (const pkg of discoveredPackages) {
    const packagePathFromNodeModules = pathWithinCwd(
      resolvedCwd,
      path.join(pkg.nodeModulesDir, ...pkg.name.split("/")),
    );
    if (pkg.hasRootPluginManifest) {
      manifestRoots.push(pkg.dir);
      if (packagePathFromNodeModules) {
        tracingIncludes.push(`${packagePathFromNodeModules}/plugin.yaml`);
      }
    }
    if (pkg.hasPluginsDir) {
      manifestRoots.push(path.join(pkg.dir, "plugins"));
      if (packagePathFromNodeModules) {
        tracingIncludes.push(`${packagePathFromNodeModules}/plugins/**/*`);
      }
    }
    if (pkg.hasSkillsDir) {
      skillRoots.push(path.join(pkg.dir, "skills"));
      if (packagePathFromNodeModules) {
        tracingIncludes.push(`${packagePathFromNodeModules}/skills/**/*`);
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
