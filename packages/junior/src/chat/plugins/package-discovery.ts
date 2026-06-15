import path from "node:path";
import { discoverNodeModulesDirs, isDirectory, isFile } from "@/chat/discovery";
import {
  isValidPackageName,
  resolvePackageLocation,
} from "@/package-resolution";

interface InstalledJuniorContentPackage {
  dir: string;
  nodeModulesDir?: string;
  packageName: string;
  hasRootPluginManifest: boolean;
  hasMigrationsDir: boolean;
  hasPluginsDir: boolean;
  hasSkillsDir: boolean;
}

export interface InstalledPluginPackageContent {
  packageNames: string[];
  packages: {
    dir: string;
    hasMigrationsDir: boolean;
    hasSkillsDir: boolean;
    packageName: string;
  }[];
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

/** Normalize and validate configured plugin package names. */
export function normalizePluginPackageNames(packageNames: unknown): string[] {
  if (packageNames === undefined) {
    return [];
  }

  if (!Array.isArray(packageNames)) {
    throw new Error("Plugin package names must be an array");
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const packageName of packageNames) {
    const normalizedPackageName =
      typeof packageName === "string" ? packageName.trim() : "";
    if (!normalizedPackageName || !isValidPackageName(normalizedPackageName)) {
      throw new Error("Plugin package names must be valid npm package names");
    }
    if (seen.has(normalizedPackageName)) {
      continue;
    }
    seen.add(normalizedPackageName);
    normalized.push(normalizedPackageName);
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
): { dir: string; nodeModulesDir?: string } | null {
  return (
    resolvePackageLocation(cwd, packageName, {
      nodeModulesDirs: candidateNodeModulesDirs,
    }) ?? null
  );
}

function readPluginPackageFlags(dir: string): {
  hasRootPluginManifest: boolean;
  hasMigrationsDir: boolean;
  hasPluginsDir: boolean;
  hasSkillsDir: boolean;
} | null {
  const hasRootPluginManifest = isFile(path.join(dir, "plugin.yaml"));
  const hasMigrationsDir = isDirectory(path.join(dir, "migrations"));
  const hasPluginsDir = isDirectory(path.join(dir, "plugins"));
  const hasSkillsDir = isDirectory(path.join(dir, "skills"));
  if (
    !hasRootPluginManifest &&
    !hasMigrationsDir &&
    !hasPluginsDir &&
    !hasSkillsDir
  ) {
    return null;
  }

  return {
    hasRootPluginManifest,
    hasMigrationsDir,
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

  for (const packageName of packageNames) {
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
        `Plugin package "${packageName}" was configured but does not contain plugin content; expected plugin.yaml, migrations/, plugins/, or skills/ in ${resolved.dir}`,
      );
    }

    seenPackageDirs.add(resolved.dir);
    discovered.push({
      dir: resolved.dir,
      nodeModulesDir: resolved.nodeModulesDir,
      packageName,
      ...pluginFlags,
    });
  }

  return discovered;
}

export interface DiscoverInstalledPluginPackageContentOptions {
  nodeModulesDirs?: string[];
  packageNames?: unknown;
}

/** Discover plugin package content from explicitly declared package names. */
export function discoverInstalledPluginPackageContent(
  cwd: string = process.cwd(),
  options?: DiscoverInstalledPluginPackageContentOptions,
): InstalledPluginPackageContent {
  const resolvedCwd = path.resolve(cwd);
  const packageNames = normalizePluginPackageNames(options?.packageNames);
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
          path.join(pkg.nodeModulesDir, ...pkg.packageName.split("/")),
        )
      : pathForTracingInclude(resolvedCwd, pkg.dir);
    if (pkg.hasRootPluginManifest) {
      manifestRoots.push(pkg.dir);
      if (tracingBasePath) {
        tracingIncludes.push(`${tracingBasePath}/plugin.yaml`);
      }
    }
    if (pkg.hasMigrationsDir) {
      if (tracingBasePath) {
        tracingIncludes.push(`${tracingBasePath}/migrations/**/*`);
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
      discoveredPackages.map((pkg) => pkg.packageName),
    ),
    packages: discoveredPackages.map((pkg) => ({
      dir: pkg.dir,
      hasMigrationsDir: pkg.hasMigrationsDir,
      hasSkillsDir: pkg.hasSkillsDir,
      packageName: pkg.packageName,
    })),
    manifestRoots: uniqueStringsInOrder(manifestRoots),
    skillRoots: uniqueStringsInOrder(skillRoots),
    tracingIncludes: uniqueStringsInOrder(tracingIncludes),
  };
}
