import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  applyJuniorDevelopmentDefaults,
  loadEnvFiles,
} from "./lib/load-env-files.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const exampleRoot = path.join(workspaceRoot, "apps", "example");
const packageRoot = path.join(workspaceRoot, "packages", "junior");
const tsconfigPath = path.join(packageRoot, "tsconfig.json");

loadEnvFiles([workspaceRoot, exampleRoot]);
applyJuniorDevelopmentDefaults(process.env);

const compose = spawnSync(
  "docker",
  ["compose", "up", "-d", "--wait", "postgres", "redis"],
  {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit",
  },
);
if (compose.error) {
  console.error(`Could not start local services: ${compose.error.message}`);
  process.exit(1);
}
if (compose.signal) {
  process.kill(process.pid, compose.signal);
}
if (compose.status !== 0) {
  process.exit(compose.status ?? 1);
}

const child = spawn(
  "node",
  ["--import", "tsx", "scripts/acp-local-server.ts"],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      DATABASE_URL: "postgresql://junior:junior@127.0.0.1:54322/junior",
      JUNIOR_DATABASE_DRIVER: "postgres",
      JUNIOR_STATE_ADAPTER: "redis",
      JUNIOR_STATE_KEY_PREFIX: `junior:acp-local:${process.pid}`,
      NODE_ENV: "test",
      REDIS_URL: "redis://127.0.0.1:6382",
      TSX_TSCONFIG_PATH: tsconfigPath,
    },
    stdio: "inherit",
  },
);

child.on("error", (error) => {
  console.error(`Could not start local ACP server: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
