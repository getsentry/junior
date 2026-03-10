import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  discoverNodeModulesDirs,
  listTopLevelPackages,
} from "@/chat/discovery-roots";
import { isDirectory, isFile } from "@/chat/fs-utils";

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
  const raw = process.env.JUNIOR_PLUGIN_PACKAGES;
  if (raw === undefined) {
    return null;
  }
  try {
    return parseRuntimeConfiguredPackageNames(JSON.parse(raw)) ?? [];
  } catch {
    return [];
  }
}

function findWorkspaceRoot(cwd: string): string | null {
  let current = path.resolve(cwd);

  while (true) {
    const candidate = path.join(current, "pnpm-workspace.yaml");
    if (isFile(candidate)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function readWorkspacePackagePatterns(workspaceRoot: string): string[] {
  try {
    const raw = readFileSync(
      path.join(workspaceRoot, "pnpm-workspace.yaml"),
      "utf8",
    );
    const parsed = parseYaml(raw) as { packages?: unknown };
    return Array.isArray(parsed.packages)
      ? parsed.packages.filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.trim().length > 0,
        )
      : [];
  } catch {
    return [];
  }
}

function listWorkspacePackageDirs(workspaceRoot: string): string[] {
  const packagePatterns = readWorkspacePackagePatterns(workspaceRoot);
  const discovered: string[] = [];
  const seen = new Set<string>();

  const addDir = (candidate: string) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized) || !isDirectory(normalized)) {
      return;
    }
    seen.add(normalized);
    discovered.push(normalized);
  };

  for (const pattern of packagePatterns) {
    const trimmed = pattern.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.endsWith("/*")) {
      const baseDir = path.join(workspaceRoot, trimmed.slice(0, -2));
      if (!isDirectory(baseDir)) {
        continue;
      }
      for (const entry of readdirSync(baseDir)) {
        addDir(path.join(baseDir, entry));
      }
      continue;
    }

    addDir(path.join(workspaceRoot, trimmed));
  }

  return discovered;
}

function discoverWorkspacePluginPackageDirs(
  cwd: string,
  packageNames: string[] | null,
): string[] {
  if (packageNames !== null) {
    return [];
  }

  const workspaceRoot = findWorkspaceRoot(cwd);
  if (!workspaceRoot) {
    return [];
  }

  const discovered: string[] = [];
  const seen = new Set<string>();
  const addIfPluginPackage = (candidate: string) => {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized) || !isDirectory(normalized)) {
      return;
    }
    const hasRootPluginManifest = isFile(path.join(normalized, "plugin.yaml"));
    const hasPluginsDir = isDirectory(path.join(normalized, "plugins"));
    const hasSkillsDir = isDirectory(path.join(normalized, "skills"));
    if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
      return;
    }
    seen.add(normalized);
    discovered.push(normalized);
  };

  for (const candidate of listWorkspacePackageDirs(workspaceRoot)) {
    addIfPluginPackage(candidate);
  }

  return discovered;
}

function resolveWorkspacePackageDirFromName(
  cwd: string,
  packageName: string,
): string | null {
  const workspaceRoot = findWorkspaceRoot(cwd);
  if (!workspaceRoot) {
    return null;
  }

  for (const candidate of listWorkspacePackageDirs(workspaceRoot)) {
    let parsedName: unknown;
    try {
      const raw = readFileSync(path.join(candidate, "package.json"), "utf8");
      parsedName = (JSON.parse(raw) as { name?: unknown }).name;
    } catch {
      continue;
    }
    if (parsedName !== packageName) {
      continue;
    }
    return candidate;
  }

  return null;
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
  cwd: string,
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
    const workspaceDir = resolved
      ? null
      : resolveWorkspacePackageDirFromName(cwd, packageName);
    if (!resolved && !workspaceDir) {
      continue;
    }
    const packageDir = resolved?.dir ?? workspaceDir!;

    if (seenPackageNames.has(packageName) || seenPackageDirs.has(packageDir)) {
      continue;
    }

    const hasRootPluginManifest = isFile(path.join(packageDir, "plugin.yaml"));
    const hasPluginsDir = isDirectory(path.join(packageDir, "plugins"));
    const hasSkillsDir = isDirectory(path.join(packageDir, "skills"));
    if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
      continue;
    }

    seenPackageNames.add(packageName);
    seenPackageDirs.add(packageDir);
    discovered.push({
      name: packageName,
      dir: packageDir,
      nodeModulesDir: resolved?.nodeModulesDir ?? null,
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
  packageNames?: string[] | null,
): InstalledJuniorContentPackage[] {
  const resolvedCwd = path.resolve(cwd);
  const candidateNodeModulesDirs =
    nodeModulesDirs ?? discoverNodeModulesDirs(resolvedCwd);
  const configuredPackageNames =
    packageNames ?? readNextRuntimeConfiguredPackageNames();
  const declaredPackages = discoverDeclaredPackages(
    resolvedCwd,
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
  const configuredPackageNames =
    options?.packageNames ?? readNextRuntimeConfiguredPackageNames();
  const discoveredPackages = discoverInstalledJuniorContentPackages(
    resolvedCwd,
    options?.nodeModulesDirs,
    configuredPackageNames,
  );
  const workspacePluginDirs = discoverWorkspacePluginPackageDirs(
    resolvedCwd,
    configuredPackageNames,
  );
  const manifestRoots: string[] = [];
  const skillRoots: string[] = [];
  const tracingIncludes: string[] = [];

  for (const pkg of discoveredPackages) {
    const packagePathFromNodeModules = pkg.nodeModulesDir
      ? pathWithinCwd(
          resolvedCwd,
          path.join(pkg.nodeModulesDir, ...pkg.name.split("/")),
        )
      : null;
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

  for (const pluginDir of workspacePluginDirs) {
    if (isFile(path.join(pluginDir, "plugin.yaml"))) {
      manifestRoots.push(pluginDir);
    }
    if (isDirectory(path.join(pluginDir, "plugins"))) {
      manifestRoots.push(path.join(pluginDir, "plugins"));
    }
    if (isDirectory(path.join(pluginDir, "skills"))) {
      skillRoots.push(path.join(pluginDir, "skills"));
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
