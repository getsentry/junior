import fs from "node:fs";
import path from "node:path";

function envFileNames(nodeEnv: string): string[] {
  return [
    `.env.${nodeEnv}.local`,
    ...(nodeEnv === "test" ? [] : [".env.local"]),
    `.env.${nodeEnv}`,
    ".env",
    ".env.example",
  ];
}

export const JUNIOR_LOCAL_DEV_INTERNAL_SECRET = "junior-local-dev-internal";
export const JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET = "junior-local-dev-heartbeat";

function hasValue(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Apply global development defaults after env files have been loaded. */
export function applyJuniorDevelopmentDefaults(
  env: NodeJS.ProcessEnv,
  options: { baseUrl?: string } = {},
): void {
  const nodeEnv = env.NODE_ENV ?? "development";
  if (nodeEnv !== "development") {
    return;
  }

  if (!hasValue(env.JUNIOR_SECRET)) {
    env.JUNIOR_SECRET = JUNIOR_LOCAL_DEV_INTERNAL_SECRET;
  }
  if (!hasValue(env.JUNIOR_STATE_ADAPTER)) {
    env.JUNIOR_STATE_ADAPTER = "memory";
  }
  if (!hasValue(env.JUNIOR_SCHEDULER_SECRET) && !hasValue(env.CRON_SECRET)) {
    env.JUNIOR_SCHEDULER_SECRET = JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET;
  }
  const baseUrl = options.baseUrl;
  if (!hasValue(env.JUNIOR_BASE_URL) && hasValue(baseUrl)) {
    env.JUNIOR_BASE_URL = baseUrl.trim();
  }
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

  applyJuniorDevelopmentDefaults(process.env);
}
