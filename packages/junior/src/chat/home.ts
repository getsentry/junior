import fs from "node:fs";
import path from "node:path";

const BUNDLED_ASSETS_ROOT = path.join(".next", "server", "runtime-assets");

function workspaceHomeDir(): string {
  return path.resolve(process.cwd());
}

function bundledAssetsHomeDir(): string {
  return path.join(workspaceHomeDir(), BUNDLED_ASSETS_ROOT);
}

export function homeDir(): string {
  const workspaceHome = workspaceHomeDir();
  if (fs.existsSync(path.join(workspaceHome, "data"))) {
    return workspaceHome;
  }

  const bundledHome = bundledAssetsHomeDir();
  if (fs.existsSync(path.join(bundledHome, "data"))) {
    return bundledHome;
  }

  return workspaceHome;
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
