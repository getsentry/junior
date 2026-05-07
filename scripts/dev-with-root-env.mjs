import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  linkDirectory,
  resolveInjectedPackageDir,
} from "./lib/injected-package-sync.mjs";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const nodeEnv = process.env.NODE_ENV ?? "development";
const devPort = process.env.PORT?.trim() || "3000";
const juniorPackageDir = path.join(workspaceRoot, "packages", "junior");
const exampleDir = path.join(workspaceRoot, "apps", "example");

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

function syncInjectedJuniorDist(options = {}) {
  // `inject-workspace-packages=true` makes the example app resolve
  // `@sentry/junior` from pnpm's injected package copy under
  // `node_modules/.pnpm/...`, not directly from `packages/junior`.
  // Point the injected package `dist` at the live workspace build output so
  // `pnpm dev` executes the latest local build without recursive copy races.
  const injectedPackageDir = resolveInjectedPackageDir(
    "@sentry/junior",
    exampleDir,
  );
  if (!injectedPackageDir) {
    const error = new Error(
      "Unable to resolve injected @sentry/junior package for apps/example dev runtime",
    );
    if (options.strict ?? false) {
      throw error;
    }
    console.error(error.message);
    return;
  }

  linkDirectory(
    path.join(juniorPackageDir, "dist"),
    path.join(injectedPackageDir, "dist"),
  );
}

const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
const tunnelUrl =
  process.env.CLOUDFLARE_TUNNEL_URL?.trim() || `http://localhost:${devPort}`;

runRequiredChild("pnpm", ["build"], {
  cwd: juniorPackageDir,
});
syncInjectedJuniorDist({ strict: true });

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
