import path from "node:path";

export function homeDir(): string {
  return path.resolve(process.cwd());
}

export function dataDir(): string {
  return path.join(homeDir(), "data");
}

export function soulPath(): string {
  return path.join(dataDir(), "SOUL.md");
}

export function skillsDir(): string {
  return path.join(homeDir(), "skills");
}

export function pluginsDir(): string {
  return path.join(homeDir(), "plugins");
}
