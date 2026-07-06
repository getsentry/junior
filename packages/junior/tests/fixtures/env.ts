import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import {
  createDefaultEnvFileLoader,
  createEnvFileLoader,
} from "../../src/env/files";

const ENV_FILES = [".env", ".env.local", ".env.test", ".env.test.local"];
const POSTGRES_HARNESS_SKIP_ENV = "JUNIOR_SKIP_POSTGRES_HARNESS";

export interface JuniorTestEnvOptions {
  packageRoots: string[];
  workspaceRoot: string;
}

/**
 * Load Junior's test environment with apps/example defaults before local overrides.
 */
export function loadJuniorTestEnvFiles(options: JuniorTestEnvOptions): void {
  const applyDefaultEnvFile = createDefaultEnvFileLoader();
  const applyEnvFile = createEnvFileLoader();
  const roots = [
    path.resolve(options.workspaceRoot, "apps/example"),
    options.workspaceRoot,
    ...options.packageRoots,
  ];
  const seen = new Set<string>();
  const shellProvidedDatabaseUrl = process.env.DATABASE_URL !== undefined;
  const shellProvidedHarnessSkip = process.env[POSTGRES_HARNESS_SKIP_ENV];
  let envFileProvidedDatabaseUrl = false;

  for (const root of roots) {
    const absoluteRoot = path.resolve(root);
    if (seen.has(absoluteRoot)) {
      continue;
    }
    seen.add(absoluteRoot);

    const examplePath = path.resolve(absoluteRoot, ".env.example");
    if (fs.existsSync(examplePath)) {
      applyDefaultEnvFile(examplePath);
    }

    for (const envFile of ENV_FILES) {
      const absolutePath = path.resolve(absoluteRoot, envFile);
      if (!fs.existsSync(absolutePath)) {
        continue;
      }
      if (
        Object.hasOwn(
          parseEnv(fs.readFileSync(absolutePath, "utf8")),
          "DATABASE_URL",
        )
      ) {
        envFileProvidedDatabaseUrl = true;
      }
      applyEnvFile(absolutePath);
    }
  }

  if (!shellProvidedDatabaseUrl && !envFileProvidedDatabaseUrl) {
    process.env[POSTGRES_HARNESS_SKIP_ENV] ??= "1";
  } else if (shellProvidedHarnessSkip === undefined) {
    delete process.env[POSTGRES_HARNESS_SKIP_ENV];
  }
}
