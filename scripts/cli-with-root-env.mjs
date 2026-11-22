import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  applyJuniorDevelopmentDefaults,
  JUNIOR_LOCAL_QUEUE_REDIS_URL,
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

loadEnvFiles([workspaceRoot, exampleRoot]);
applyJuniorDevelopmentDefaults(
  process.env,
  // The core engine runs its steps on a BullMQ worker in the CLI process.
  coreEngineChat ? { queueRedisUrl: JUNIOR_LOCAL_QUEUE_REDIS_URL } : {},
);

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
