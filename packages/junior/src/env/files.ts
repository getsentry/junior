import fs from "node:fs";
import { parseEnv } from "node:util";

/**
 * Create an env-file loader that preserves caller-supplied environment values
 * while letting later env files override earlier env files in the same load
 * sequence.
 */
export function createEnvFileLoader(
  targetEnv: NodeJS.ProcessEnv = process.env,
): (absolutePath: string) => void {
  const protectedKeys = new Set(Object.keys(targetEnv));
  const loadedKeys = new Set<string>();

  return (absolutePath: string) => {
    const values = parseEnv(fs.readFileSync(absolutePath, "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (protectedKeys.has(name) && !loadedKeys.has(name)) {
        continue;
      }
      targetEnv[name] = value;
      loadedKeys.add(name);
    }
  };
}

/** Create an env-file loader for checked-in defaults that never override. */
export function createDefaultEnvFileLoader(
  targetEnv: NodeJS.ProcessEnv = process.env,
): (absolutePath: string) => void {
  return (absolutePath: string) => {
    const values = parseEnv(fs.readFileSync(absolutePath, "utf8"));
    for (const [name, value] of Object.entries(values)) {
      if (targetEnv[name] !== undefined) {
        continue;
      }
      targetEnv[name] = value;
    }
  };
}
