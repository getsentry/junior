import fs from "node:fs";
import path from "node:path";

export function homeDir(): string {
  return detectAppDir();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hasAnyDataMarkers(appDir: string): boolean {
  return pathExists(path.join(appDir, "SOUL.md"));
}

function detectAppDir(): string {
  const cwd = process.cwd();
  const directApp = path.resolve(cwd, "app");
  if (pathExists(directApp)) {
    return directApp;
  }

  const candidates: string[] = [];
  const packageRoots: string[] = [];
  const localPackagesDir = path.join(cwd, "packages");
  if (pathExists(localPackagesDir)) {
    for (const entry of fs.readdirSync(localPackagesDir)) {
      packageRoots.push(path.join(localPackagesDir, entry));
    }
  }

  for (const entry of fs.readdirSync(cwd)) {
    const child = path.join(cwd, entry);
    const nestedPackages = path.join(child, "packages");
    if (!pathExists(nestedPackages)) {
      continue;
    }
    for (const nestedEntry of fs.readdirSync(nestedPackages)) {
      packageRoots.push(path.join(nestedPackages, nestedEntry));
    }
  }

  for (const root of packageRoots) {
    const appDir = path.join(root, "app");
    if (!pathExists(appDir)) {
      continue;
    }
    candidates.push(appDir);
  }

  if (candidates.length === 0) {
    return directApp;
  }

  candidates.sort((left, right) => {
    const leftScore = Number(hasAnyDataMarkers(left));
    const rightScore = Number(hasAnyDataMarkers(right));
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.localeCompare(right);
  });
  return candidates[0];
}

function resolveContentRoots(subdir: "data" | "skills" | "plugins"): string[] {
  if (subdir === "data") {
    return [homeDir()];
  }

  if (subdir === "skills") {
    return [path.join(homeDir(), "skills"), path.resolve(process.cwd(), "skills")];
  }

  return [path.join(homeDir(), "plugins")];
}

export function dataDir(): string {
  return resolveContentRoots("data")[0];
}

export function soulPath(): string {
  return path.join(dataDir(), "SOUL.md");
}

export function skillsDir(): string {
  return resolveContentRoots("skills")[0];
}

export function pluginsDir(): string {
  return resolveContentRoots("plugins")[0];
}

export function dataRoots(): string[] {
  return unique(resolveContentRoots("data"));
}

export function skillRoots(): string[] {
  return unique(resolveContentRoots("skills"));
}

export function pluginRoots(): string[] {
  return unique(resolveContentRoots("plugins"));
}

export function soulPathCandidates(): string[] {
  const candidates = dataRoots().map((root) => path.join(root, "SOUL.md"));
  return unique(candidates);
}
