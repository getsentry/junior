import fs from "node:fs";
import { parseEnv } from "node:util";
import path from "node:path";

function envFileNames(nodeEnv) {
  return [
    `.env.${nodeEnv}.local`,
    nodeEnv === "test" ? null : ".env.local",
    `.env.${nodeEnv}`,
    ".env",
  ].filter(Boolean);
}

export const JUNIOR_LOCAL_DEV_INTERNAL_SECRET = "junior-local-dev-internal";
export const JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET = "junior-local-dev-heartbeat";

function hasValue(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** Apply global development defaults after env files have been loaded. */
export function applyJuniorDevelopmentDefaults(env, options = {}) {
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
  if (!hasValue(env.JUNIOR_BASE_URL) && hasValue(options.baseUrl)) {
    env.JUNIOR_BASE_URL = options.baseUrl.trim();
  }
}

/** Load env files so app-local defaults override repo defaults without replacing shell env. */
export function loadEnvFiles(roots, options = {}) {
  const env = options.env ?? process.env;
  const nodeEnv = env.NODE_ENV ?? "development";
  const protectedKeys = new Set(Object.keys(env));
  const loadedKeys = new Set();

  for (const root of roots) {
    const absolutePath = path.join(root, ".env.example");
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const values = parseEnv(fs.readFileSync(absolutePath, "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (env[name] !== undefined) {
        continue;
      }
      env[name] = value;
    }
  }

  // Shell env wins; later env files override earlier loaded files.
  for (const root of roots) {
    for (const relativePath of envFileNames(nodeEnv)) {
      const absolutePath = path.join(root, relativePath);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }

      const values = parseEnv(fs.readFileSync(absolutePath, "utf8"));
      for (const [name, value] of Object.entries(values)) {
        if (protectedKeys.has(name) && !loadedKeys.has(name)) {
          continue;
        }
        if (value === "" && env[name]?.trim()) {
          continue;
        }
        env[name] = value;
        loadedKeys.add(name);
      }
    }
  }
}
