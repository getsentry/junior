import { readFileSync, statSync } from "node:fs";
import path from "node:path";

interface RootPackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface InstalledJuniorContentPackage {
  name: string;
  dir: string;
  hasRootPluginManifest: boolean;
  hasPluginsDir: boolean;
  hasSkillsDir: boolean;
}

export interface InstalledPluginPackageContent {
  manifestRoots: string[];
  skillRoots: string[];
  tracingIncludes: string[];
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

function readRootPackageJson(cwd: string): RootPackageJson | null {
  const rootPackageJsonPath = path.join(cwd, "package.json");
  try {
    const raw = readFileSync(rootPackageJsonPath, "utf8");
    return JSON.parse(raw) as RootPackageJson;
  } catch {
    return null;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function readInstalledDependencyNames(cwd: string): string[] {
  const rootPackageJson = readRootPackageJson(cwd);
  if (!rootPackageJson) {
    return [];
  }

  return uniqueSorted([
    ...Object.keys(rootPackageJson.dependencies ?? {}),
    ...Object.keys(rootPackageJson.optionalDependencies ?? {})
  ]);
}

function packageInstallDir(cwd: string, packageName: string): string {
  return path.join(cwd, "node_modules", ...packageName.split("/"));
}

function discoverInstalledJuniorContentPackages(cwd: string = process.cwd()): InstalledJuniorContentPackage[] {
  const dependencies = readInstalledDependencyNames(cwd);
  const discovered: InstalledJuniorContentPackage[] = [];

  for (const dependency of dependencies) {
    const dir = packageInstallDir(cwd, dependency);
    if (!isDirectory(dir)) {
      continue;
    }

    const hasRootPluginManifest = isFile(path.join(dir, "plugin.yaml"));
    const hasPluginsDir = isDirectory(path.join(dir, "plugins"));
    const hasSkillsDir = isDirectory(path.join(dir, "skills"));
    if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
      continue;
    }

    discovered.push({
      name: dependency,
      dir,
      hasRootPluginManifest,
      hasPluginsDir,
      hasSkillsDir
    });
  }

  return discovered;
}

export function discoverInstalledPluginPackageContent(cwd: string = process.cwd()): InstalledPluginPackageContent {
  const manifestRoots: string[] = [];
  const skillRoots: string[] = [];
  const tracingIncludes: string[] = [];

  for (const pkg of discoverInstalledJuniorContentPackages(cwd)) {
    const base = `./node_modules/${pkg.name}`;
    if (pkg.hasRootPluginManifest) {
      manifestRoots.push(pkg.dir);
      tracingIncludes.push(`${base}/plugin.yaml`);
    }
    if (pkg.hasPluginsDir) {
      manifestRoots.push(path.join(pkg.dir, "plugins"));
      tracingIncludes.push(`${base}/plugins/**/*`);
    }
    if (pkg.hasSkillsDir) {
      skillRoots.push(path.join(pkg.dir, "skills"));
      tracingIncludes.push(`${base}/skills/**/*`);
    }
  }

  return {
    manifestRoots: uniqueSorted(manifestRoots),
    skillRoots: uniqueSorted(skillRoots),
    tracingIncludes: uniqueSorted(tracingIncludes)
  };
}
