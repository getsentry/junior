import fs from "node:fs";
import path from "node:path";

export function homeDir(): string {
  return path.resolve(process.cwd(), "app");
}

function legacyHomeDir(): string {
  return path.resolve(process.cwd());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveContentRoots(subdir: "data" | "skills" | "plugins"): string[] {
  const canonical = path.join(homeDir(), subdir);
  const legacy = path.join(legacyHomeDir(), subdir);
  if (canonical === legacy) {
    return [canonical];
  }

  // Canonical `app/*` always takes precedence.
  if (fs.existsSync(canonical)) {
    return [canonical, legacy];
  }

  // If only legacy exists, keep backward compatibility.
  if (fs.existsSync(legacy)) {
    return [legacy, canonical];
  }

  // If neither exists yet (fresh scaffold), default to canonical.
  return [canonical, legacy];
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
