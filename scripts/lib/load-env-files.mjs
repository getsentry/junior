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

/** Load env files so app-local defaults override repo defaults without replacing shell env. */
export function loadEnvFiles(roots, options = {}) {
  const env = options.env ?? process.env;
  const nodeEnv = env.NODE_ENV ?? "development";
  const protectedKeys = new Set(Object.keys(env));
  const loadedKeys = new Set();

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
        env[name] = value;
        loadedKeys.add(name);
      }
    }
  }
}
