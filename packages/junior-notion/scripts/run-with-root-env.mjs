import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageScriptsRoot = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(packageScriptsRoot, "../../..");
const nodeEnv = process.env.NODE_ENV ?? "development";
const rawArgs = process.argv.slice(2);

if (rawArgs.length === 0) {
  throw new Error("run-with-root-env requires a helper script path");
}

const [helperRelativePath, ...helperArgs] = rawArgs;
const envCandidates = [
  `.env.${nodeEnv}.local`,
  nodeEnv === "test" ? null : ".env.local",
  `.env.${nodeEnv}`,
  ".env",
].filter(Boolean);

for (const relativePath of envCandidates) {
  const absolutePath = path.join(workspaceRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    continue;
  }

  process.loadEnvFile(absolutePath);
}

const helperPath = path.resolve(packageScriptsRoot, helperRelativePath);
const child = spawn("node", [helperPath, ...helperArgs], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
