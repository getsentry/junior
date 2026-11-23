import { spawn } from "node:child_process";
import { createServer } from "node:net";
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
const juniorTsconfigPath = path.join(
  workspaceRoot,
  "packages",
  "junior",
  "tsconfig.json",
);
const rawCliArgs = process.argv.slice(2);
const cliArgs = rawCliArgs[0] === "--" ? rawCliArgs.slice(1) : rawCliArgs;

const coreEngineChat =
  cliArgs[0] === "chat" && cliArgs[1] === "--engine" && cliArgs[2] === "core";

/** A free port on 127.0.0.1. */
async function freePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

loadEnvFiles([workspaceRoot, exampleRoot]);
applyJuniorDevelopmentDefaults(process.env);
// The core engine runs a local queue server in the CLI process. Chat config
// reads its URL when it loads, so pick the port before the CLI starts.
if (coreEngineChat && !process.env.JUNIOR_QUEUE_API_URL?.trim()) {
  process.env.JUNIOR_QUEUE_API_URL = `http://127.0.0.1:${await freePort()}`;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      ...options,
    });
    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

const cliResult = await run(
  "node",
  ["--import", "tsx", "../../packages/junior/src/cli/main.ts", ...cliArgs],
  {
    cwd: exampleRoot,
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: juniorTsconfigPath,
    },
  },
);
if (cliResult.signal) {
  process.kill(process.pid, cliResult.signal);
}
process.exit(cliResult.code);
