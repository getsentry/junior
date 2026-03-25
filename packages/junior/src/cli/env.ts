import fs from "node:fs";
import path from "node:path";

function envFileNames(nodeEnv: string): string[] {
  return [
    `.env.${nodeEnv}.local`,
    ...(nodeEnv === "test" ? [] : [".env.local"]),
    `.env.${nodeEnv}`,
    ".env",
  ];
}

function hasEnvRootMarker(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) ||
    fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))
  );
}

function resolveCliEnvRoots(cwd: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  const addRoot = (candidate: string) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    roots.push(resolved);
  };

  let current = path.resolve(cwd);
  addRoot(current);

  while (true) {
    if (hasEnvRootMarker(current)) {
      addRoot(current);
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

/**
 * Load CLI env files from the nearest package root and workspace root so
 * `pnpm exec junior ...` sees the same credentials as local repo scripts.
 */
export function loadCliEnvFiles(cwd: string = process.cwd()): void {
  const nodeEnv = process.env.NODE_ENV ?? "development";

  for (const root of resolveCliEnvRoots(cwd)) {
    for (const envFile of envFileNames(nodeEnv)) {
      const absolutePath = path.join(root, envFile);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }

      process.loadEnvFile(absolutePath);
    }
  }
}
