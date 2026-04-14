import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nodeEnv = process.env.NODE_ENV ?? "development";
const devPort = process.env.PORT?.trim() || "3000";
const juniorPackageDir = path.join(workspaceRoot, "packages", "junior");

process.env.NODE_ENV = nodeEnv;
process.env.PORT = devPort;
if (!process.env.NO_COLOR && !process.env.FORCE_COLOR) {
  const hasTty =
    Boolean(process.stdout?.isTTY) || Boolean(process.stderr?.isTTY);
  if (hasTty) {
    process.env.FORCE_COLOR = "1";
  }
}

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

function runRequiredChild(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    ...options,
  });

  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
const tunnelUrl =
  process.env.CLOUDFLARE_TUNNEL_URL?.trim() || `http://localhost:${devPort}`;

runRequiredChild("pnpm", ["build"], {
  cwd: juniorPackageDir,
});

spawnChild("pnpm", ["exec", "tsup", "--watch", "--silent", "--no-clean"], {
  cwd: juniorPackageDir,
});

if (tunnelToken) {
  spawnChild("cloudflared", [
    "tunnel",
    "--no-autoupdate",
    "--loglevel",
    "warn",
    "--transport-loglevel",
    "error",
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
