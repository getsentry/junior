import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nodeEnv = process.env.NODE_ENV ?? "development";
const devPort = process.env.PORT?.trim() || "3000";

process.env.PORT = devPort;

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

const children = new Set();

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  children.add(child);
  child.on("exit", () => {
    children.delete(child);
  });

  return child;
}

function terminateChildren(signal = "SIGTERM") {
  for (const child of children) {
    if (child.killed) {
      continue;
    }

    child.kill(signal);
  }
}

const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
const tunnelUrl =
  process.env.CLOUDFLARE_TUNNEL_URL?.trim() || `http://localhost:${devPort}`;

if (tunnelToken) {
  spawnChild("cloudflared", [
    "tunnel",
    "run",
    "--token",
    tunnelToken,
    "--url",
    tunnelUrl,
  ]);
}

const exampleDir = path.join(workspaceRoot, "apps", "example");
const child = spawnChild("pnpm", ["dev"], { cwd: exampleDir });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    terminateChildren(signal);
  });
}

child.on("exit", (code, signal) => {
  terminateChildren(signal ?? "SIGTERM");

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
