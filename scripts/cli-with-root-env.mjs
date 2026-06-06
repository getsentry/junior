import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = path.join(workspaceRoot, "apps", "example");
const juniorTsconfigPath = path.join(workspaceRoot, "packages", "junior", "tsconfig.json");
const nodeEnv = process.env.NODE_ENV ?? "development";
const rawCliArgs = process.argv.slice(2);
const cliArgs = rawCliArgs[0] === "--" ? rawCliArgs.slice(1) : rawCliArgs;

const envCandidates = [
  `.env.${nodeEnv}.local`,
  nodeEnv === "test" ? null : ".env.local",
  `.env.${nodeEnv}`,
  ".env"
].filter(Boolean);

for (const relativePath of envCandidates) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  process.loadEnvFile(absolutePath);
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: process.env,
      ...options
    });
    child.on("exit", (code, signal) => {
      resolve({ code: code ?? 1, signal });
    });
  });
}

const cliResult = await run("node", ["--import", "tsx", "../../packages/junior/src/cli/main.ts", ...cliArgs], {
  cwd: exampleRoot,
  env: {
    ...process.env,
    TSX_TSCONFIG_PATH: juniorTsconfigPath
  }
});
if (cliResult.signal) {
  process.kill(process.pid, cliResult.signal);
}
process.exit(cliResult.code);
