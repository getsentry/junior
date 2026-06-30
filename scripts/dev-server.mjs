import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  applyJuniorDevelopmentDefaults,
  JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET,
  loadEnvFiles,
} from "./lib/load-env-files.mjs";
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
const dashboardPackageDir = path.join(
  workspaceRoot,
  "packages",
  "junior-dashboard",
);
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

loadEnvFiles([workspaceRoot, exampleDir]);

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

function syncInjectedPackageDist(packageName, packageDir, options = {}) {
  // `inject-workspace-packages=true` makes the example app resolve
  // workspace dependencies from pnpm's injected package copies under
  // `node_modules/.pnpm/...`, not directly from `packages/*`.
  // Point the injected package `dist` at the live workspace build output so
  // `pnpm dev` executes the latest local build without recursive copy races.
  const injectedPackageDirs = [workspaceRoot, exampleDir]
    .map((consumerDir) => resolveInjectedPackageDir(packageName, consumerDir))
    .filter((value, index, values) => value && values.indexOf(value) === index);
  if (injectedPackageDirs.length === 0) {
    const error = new Error(
      `Unable to resolve injected ${packageName} package for apps/example dev runtime`,
    );
    if (options.strict ?? false) {
      throw error;
    }
    console.error(error.message);
    return;
  }

  for (const injectedPackageDir of injectedPackageDirs) {
    linkDirectory(
      path.join(packageDir, "dist"),
      path.join(injectedPackageDir, "dist"),
    );
  }
}

const tunnelToken = process.env.CLOUDFLARE_TUNNEL_TOKEN?.trim();
const tunnelUrl =
  process.env.CLOUDFLARE_TUNNEL_URL?.trim() || `http://localhost:${devPort}`;
applyJuniorDevelopmentDefaults(process.env, {
  baseUrl: `http://localhost:${devPort}`,
});
if (
  !process.env.JUNIOR_SCHEDULER_SECRET?.trim() &&
  !process.env.CRON_SECRET?.trim()
) {
  process.env.JUNIOR_SCHEDULER_SECRET = JUNIOR_LOCAL_DEV_HEARTBEAT_SECRET;
}
const heartbeatSecret =
  process.env.JUNIOR_SCHEDULER_SECRET?.trim() ||
  process.env.CRON_SECRET?.trim();
const heartbeatUrl =
  process.env.JUNIOR_DEV_HEARTBEAT_URL?.trim() ||
  `http://localhost:${devPort}/api/internal/heartbeat`;
const heartbeatIntervalMs = 60_000;

async function pulseHeartbeat() {
  try {
    const response = await fetch(heartbeatUrl, {
      headers: { authorization: `Bearer ${heartbeatSecret}` },
    });
    if (!response.ok) {
      console.error(
        `Local heartbeat returned ${response.status} ${response.statusText}`,
      );
    }
  } catch (error) {
    console.error(
      `Local heartbeat failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function startLocalHeartbeat() {
  const initialDelayMs = 5_000;
  const initialTimer = setTimeout(() => {
    void pulseHeartbeat();
  }, initialDelayMs);
  const interval = setInterval(() => {
    void pulseHeartbeat();
  }, heartbeatIntervalMs);

  children.add({
    killed: false,
    kill() {
      clearTimeout(initialTimer);
      clearInterval(interval);
      this.killed = true;
    },
  });
}

let nitroChild;
let restartingNitro = false;

function clearExampleVercelOutput() {
  fs.rmSync(path.join(exampleDir, ".vercel", "output"), {
    force: true,
    recursive: true,
  });
}

function startNitroDev() {
  nitroChild = spawnChild("pnpm", [
    "exec",
    "sentry",
    "local",
    "run",
    "--port",
    "8969",
    "pnpm",
    "--dir",
    exampleDir,
    "exec",
    "nitro",
    "dev",
  ]);

  nitroChild.on("exit", (code, signal) => {
    if (restartingNitro) {
      return;
    }

    terminateChildren(signal ?? "SIGTERM");

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 1);
  });
}

function restartNitroDev() {
  if (!nitroChild || nitroChild.killed) {
    clearExampleVercelOutput();
    startNitroDev();
    return;
  }

  restartingNitro = true;
  nitroChild.once("exit", () => {
    clearExampleVercelOutput();
    restartingNitro = false;
    startNitroDev();
  });
  nitroChild.kill("SIGTERM");
}

function watchDistForNitroRestart() {
  let timer;
  const scheduleRestart = () => {
    clearTimeout(timer);
    timer = setTimeout(restartNitroDev, 1500);
  };

  for (const distDir of [
    path.join(juniorPackageDir, "dist"),
    path.join(dashboardPackageDir, "dist"),
  ]) {
    const watcher = fs.watch(distDir, scheduleRestart);
    children.add({
      killed: false,
      kill() {
        clearTimeout(timer);
        watcher.close();
        this.killed = true;
      },
    });
  }
}

runRequiredChild("pnpm", ["build"], {
  cwd: juniorPackageDir,
});
runRequiredChild("pnpm", ["build"], {
  cwd: dashboardPackageDir,
});
syncInjectedPackageDist("@sentry/junior", juniorPackageDir, { strict: true });
syncInjectedPackageDist("@sentry/junior-dashboard", dashboardPackageDir, {
  strict: true,
});
clearExampleVercelOutput();

spawnChild("pnpm", ["exec", "tsup", "--watch", "--silent", "--no-clean"], {
  cwd: juniorPackageDir,
});
spawnChild("pnpm", ["exec", "tsup", "--watch", "--silent", "--no-clean"], {
  cwd: dashboardPackageDir,
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

watchDistForNitroRestart();
startNitroDev();
startLocalHeartbeat();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    terminateChildren(signal);
  });
}
