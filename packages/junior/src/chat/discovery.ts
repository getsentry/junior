import fs, { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Check whether a path exists and is a directory. */
export function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

/** Check whether a path exists and is a regular file. */
export function isFile(targetPath: string): boolean {
  try {
    return statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Node-modules and project-root discovery
// ---------------------------------------------------------------------------

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function uniqueResolvedPathsInOrder(values: string[]): string[] {
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
    if (
      isNodeModulesPath(current) &&
      !isInsidePnpmStore(current) &&
      isDirectory(current)
    ) {
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

/** Discover node_modules directories reachable from the current working directory. */
export function discoverNodeModulesDirs(
  cwd: string = process.cwd(),
  options?: DiscoverNodeModulesDirsOptions,
): string[] {
  const explicit =
    options?.candidateDirs?.filter((dir) => isDirectory(dir)) ?? [];
  if (explicit.length > 0) {
    return uniqueResolvedPathsInOrder(explicit);
  }

  return uniqueResolvedPathsInOrder([
    ...listInstalledPackageNodeModulesDirs(),
    ...listCwdAncestorNodeModulesDirs(cwd),
  ]);
}

export interface DiscoverProjectRootsOptions {
  nodeModulesDirs?: string[];
}

/** Discover project root directories by walking up from cwd and checking node_modules parents. */
export function discoverProjectRoots(
  cwd: string = process.cwd(),
  options?: DiscoverProjectRootsOptions,
): string[] {
  const roots = discoverNodeModulesDirs(
    cwd,
    options?.nodeModulesDirs
      ? { candidateDirs: options.nodeModulesDirs }
      : undefined,
  ).map((nodeModulesDir) => path.dirname(nodeModulesDir));

  return uniqueResolvedPathsInOrder([cwd, ...roots]);
}

// ---------------------------------------------------------------------------
// App home directory resolution
// ---------------------------------------------------------------------------

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
    pathExists(path.join(appDir, "WORLD.md"))
  );
}

function scoreAppCandidate(appDir: string): number {
  let score = 0;
  if (pathExists(path.join(appDir, "SOUL.md"))) {
    score += 4;
  }
  if (pathExists(path.join(appDir, "WORLD.md"))) {
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

/** Return the resolved app home directory for the current working directory. */
export function homeDir(): string {
  return resolveHomeDir();
}

export interface ResolveHomeDirOptions {
  projectRoots?: string[];
}

/** Resolve the app home directory by scoring candidate `app/` directories. */
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

/** Return the data directory (same as homeDir). */
export function dataDir(): string {
  return resolveContentRoots("data")[0];
}

/** Return the path to the SOUL.md file. */
export function soulPath(): string {
  return path.join(dataDir(), "SOUL.md");
}

/** Return the path to the WORLD.md file. */
export function worldPath(): string {
  return path.join(dataDir(), "WORLD.md");
}

/** Return the path to the DESCRIPTION.md file. */
export function descriptionPath(): string {
  return path.join(dataDir(), "DESCRIPTION.md");
}

/** Return the skills directory path. */
export function skillsDir(): string {
  return resolveContentRoots("skills")[0];
}

/** Return the plugins directory path. */
export function pluginsDir(): string {
  return resolveContentRoots("plugins")[0];
}

/** Return all unique data root directories. */
export function dataRoots(): string[] {
  return unique(resolveContentRoots("data"));
}

/** Return all unique skill root directories. */
export function skillRoots(): string[] {
  return unique(resolveContentRoots("skills"));
}

/** Return all unique plugin root directories. */
export function pluginRoots(): string[] {
  return unique(resolveContentRoots("plugins"));
}

/** Return candidate paths where SOUL.md might be found. */
export function soulPathCandidates(): string[] {
  const candidates = dataRoots().map((root) => path.join(root, "SOUL.md"));
  return unique(candidates);
}

/** Return candidate paths where WORLD.md might be found. */
export function worldPathCandidates(): string[] {
  const candidates = dataRoots().map((root) => path.join(root, "WORLD.md"));
  return unique(candidates);
}

/** Return candidate paths where DESCRIPTION.md might be found. */
export function descriptionPathCandidates(): string[] {
  const candidates = dataRoots().map((root) =>
    path.join(root, "DESCRIPTION.md"),
  );
  return unique(candidates);
}

const RESERVED_APP_FILES = new Set(["SOUL.md", "WORLD.md", "DESCRIPTION.md"]);

/** List non-reserved .md files in the app root for sandbox reference syncing. */
export function listReferenceFiles(): string[] {
  const appDir = homeDir();
  try {
    const entries = fs.readdirSync(appDir, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".md") &&
          !RESERVED_APP_FILES.has(entry.name),
      )
      .map((entry) => path.join(appDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}
