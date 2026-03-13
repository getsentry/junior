import fs from "node:fs";
import path from "node:path";
import { discoverProjectRoots } from "@/chat/discovery-roots";

export function homeDir(): string {
  return resolveHomeDir();
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
  return (
    pathExists(path.join(appDir, "SOUL.md")) ||
    pathExists(path.join(appDir, "ABOUT.md"))
  );
}

function scoreAppCandidate(appDir: string): number {
  let score = 0;
  if (pathExists(path.join(appDir, "SOUL.md"))) {
    score += 4;
  }
  if (pathExists(path.join(appDir, "ABOUT.md"))) {
    score += 2;
  }
  if (pathExists(path.join(appDir, "skills"))) {
    score += 1;
  }
  if (pathExists(path.join(appDir, "plugins"))) {
    score += 1;
  }
  return score;
}

function resolveCandidateAppDirs(
  cwd: string,
  projectRoots?: string[],
): string[] {
  const roots = projectRoots ?? discoverProjectRoots(cwd);
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    const appDir = path.resolve(root, "app");
    if (!pathExists(appDir)) {
      continue;
    }
    if (seen.has(appDir)) {
      continue;
    }
    seen.add(appDir);
    resolved.push(appDir);
  }

  return resolved;
}

export interface ResolveHomeDirOptions {
  projectRoots?: string[];
}

export function resolveHomeDir(
  cwd: string = process.cwd(),
  options?: ResolveHomeDirOptions,
): string {
  const resolvedCwd = path.resolve(cwd);
  const directApp = path.resolve(resolvedCwd, "app");
  if (pathExists(directApp) && hasAnyDataMarkers(directApp)) {
    return directApp;
  }

  const candidates = resolveCandidateAppDirs(
    resolvedCwd,
    options?.projectRoots,
  );
  if (candidates.length === 0) {
    return directApp;
  }

  candidates.sort((left, right) => {
    const leftScore = scoreAppCandidate(left);
    const rightScore = scoreAppCandidate(right);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    const leftDistance = path
      .relative(resolvedCwd, left)
      .split(path.sep).length;
    const rightDistance = path
      .relative(resolvedCwd, right)
      .split(path.sep).length;
    if (leftDistance !== rightDistance) {
      return leftDistance - rightDistance;
    }
    return left.localeCompare(right);
  });
  return candidates[0];
}

function resolveContentRoots(subdir: "data" | "skills" | "plugins"): string[] {
  if (subdir === "data") {
    return [homeDir()];
  }

  return [path.join(homeDir(), subdir)];
}

export function dataDir(): string {
  return resolveContentRoots("data")[0];
}

export function soulPath(): string {
  return path.join(dataDir(), "SOUL.md");
}

export function aboutPath(): string {
  return path.join(dataDir(), "ABOUT.md");
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

export function aboutPathCandidates(): string[] {
  const candidates = dataRoots().map((root) => path.join(root, "ABOUT.md"));
  return unique(candidates);
}
