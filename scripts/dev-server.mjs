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
const useProcessGroups = process.platform !== "win32";

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

// `OPEN_SPOTLIGHT_WEB=1` opens the Sentry Local UI. Read it after the env
// files load, so that `.env.local` can set it.
const openLocalUi = process.env.OPEN_SPOTLIGHT_WEB?.trim() === "1";

const children = new Set();
const stoppedChildren = new WeakSet();
let shuttingDown = false;

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: process.env,
    detached: useProcessGroups,
    ...options,
  });

  children.add(child);
  child.on("exit", () => {
    children.delete(child);
  });

  return child;
}

function stopChild(child, signal) {
  if (child.killed || stoppedChildren.has(child)) {
    return;
  }
  stoppedChildren.add(child);
  signalChild(child, signal);
}

function signalChild(child, signal) {
  // Long-lived commands launch wrappers. Stop their process group so a
  // restarted wrapper cannot leave the server that owns its port behind.
  if (useProcessGroups && child.pid) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
    return;
  }

  child.kill(signal);
}

function terminateChildren(signal = "SIGTERM") {
  // A restart that is waiting for an old process to exit must not start a
  // new one after shutdown begins.
  shuttingDown = true;
  for (const child of children) {
    if (child === queueWorkerChild) {
      stopQueueWorker(child);
    } else {
      stopChild(child, signal);
    }
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
  // Node resolves the linked dashboard `dist` to `packages/junior-dashboard`,
  // so the dashboard imports `@sentry/junior` from its own injected copy.
  // Link that copy too. Otherwise the app and the dashboard load two module
  // instances, and in-memory state that one writes is not visible to the other.
  const injectedPackageDirs = [workspaceRoot, exampleDir, dashboardPackageDir]
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
  // The Redis service in `compose.yaml`.
  queueRedisUrl: "redis://localhost:6382",
});
// With BullMQ, one separate worker process pulls the queue jobs.
const runQueueWorker = process.env.JUNIOR_QUEUE_PROVIDER?.trim() === "bullmq";
if (
  runQueueWorker &&
  process.env.JUNIOR_STATE_ADAPTER?.trim().toLowerCase() === "memory"
) {
  console.error(
    "JUNIOR_STATE_ADAPTER=memory does not work with the BullMQ queue: its worker runs in a separate process. Use JUNIOR_STATE_ADAPTER=redis or JUNIOR_QUEUE_PROVIDER=vercel.",
  );
  process.exit(1);
}
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

// Restarts reuse this function. Open the Sentry Local UI only on the first
// start, so that each rebuild does not open a new browser tab.
function startNitroDev({ openLocalUi = false } = {}) {
  if (shuttingDown) {
    return;
  }
  const child = spawnChild("pnpm", [
    "exec",
    "sentry",
    "local",
    "run",
    ...(openLocalUi ? ["--open"] : []),
    "--port",
    "8969",
    "--",
    "pnpm",
    "--dir",
    exampleDir,
    "exec",
    "nitro",
    "dev",
  ]);
  nitroChild = child;

  child.on("exit", (code, signal) => {
    stopChild(child, signal ?? "SIGTERM");

    if (restartingNitro && !shuttingDown) {
      return;
    }

    terminateChildren(signal ?? "SIGTERM");

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    // Wait for the queue worker, which can take its stop timeout to exit.
    if (queueWorkerChild) {
      queueWorkerChild.once("exit", () => process.exit(code ?? 1));
      return;
    }
    process.exit(code ?? 1);
  });
}

function restartNitroDev() {
  if (restartingNitro) {
    return;
  }
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
  stopChild(nitroChild, "SIGTERM");
}

let queueWorkerChild;
let restartingQueueWorker = false;
// The worker waits for running jobs when it stops. After this time, the dev
// server kills it, so that a long job cannot block a restart or shutdown.
const queueWorkerStopTimeoutMs = 10_000;

function startQueueWorker() {
  if (shuttingDown) {
    return;
  }
  const child = spawnChild(
    process.execPath,
    [path.join(workspaceRoot, "scripts", "dev-queue-worker.mjs")],
    { cwd: exampleDir },
  );
  queueWorkerChild = child;

  // A worker that fails, for example on a syntax error, does not stop the
  // dev server. The next watched change starts it again.
  child.on("exit", (code, signal) => {
    if (queueWorkerChild === child) {
      queueWorkerChild = undefined;
    }
    if (!stoppedChildren.has(child)) {
      console.error(
        `Queue worker exited (${signal ?? `code ${code}`}). It starts again after the next change to Junior or the example app.`,
      );
    }
  });
}

function restartQueueWorker() {
  if (restartingQueueWorker) {
    return;
  }
  if (!queueWorkerChild) {
    startQueueWorker();
    return;
  }

  // Start the new worker only after the old one has closed, so that old
  // code never takes new jobs.
  restartingQueueWorker = true;
  queueWorkerChild.once("exit", () => {
    restartingQueueWorker = false;
    startQueueWorker();
  });
  stopQueueWorker(queueWorkerChild);
}

function stopQueueWorker(child) {
  if (stoppedChildren.has(child)) {
    return;
  }
  const timer = setTimeout(() => {
    console.error(
      `Queue worker did not stop within ${queueWorkerStopTimeoutMs / 1000} seconds. Killing it.`,
    );
    signalChild(child, "SIGKILL");
  }, queueWorkerStopTimeoutMs);
  child.once("exit", () => clearTimeout(timer));
  stopChild(child, "SIGTERM");
}

function watchForRestart(paths, restart, options = {}) {
  const { includeFile = () => true, recursive = false } = options;
  let timer;
  const scheduleRestart = (_event, filename) => {
    if (filename && !includeFile(filename)) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(restart, 1500);
  };

  for (const watchedPath of paths) {
    const watcher = fs.watch(watchedPath, { recursive }, scheduleRestart);
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

function watchForRestarts() {
  // A new Junior build restarts both processes.
  watchForRestart(
    [
      path.join(juniorPackageDir, "dist"),
      path.join(dashboardPackageDir, "dist"),
    ],
    () => {
      restartNitroDev();
      if (runQueueWorker) {
        restartQueueWorker();
      }
    },
  );
  if (!runQueueWorker) {
    return;
  }
  // Nitro reloads the example app by itself. The worker loads the app once,
  // so a change to its runtime files restarts only the worker. Watch the
  // folder, because editors often save a file by replacing it.
  const appEntryFiles = new Set(["server.ts", "plugins.ts", "dashboard.ts"]);
  watchForRestart([exampleDir], restartQueueWorker, {
    includeFile: (filename) => appEntryFiles.has(filename),
  });
  watchForRestart([path.join(exampleDir, "app")], restartQueueWorker, {
    recursive: true,
  });
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

spawnChild(
  "pnpm",
  ["exec", "tsdown", "--watch", "--logLevel", "warn", "--no-clean"],
  { cwd: juniorPackageDir },
);
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

watchForRestarts();
startNitroDev({ openLocalUi });
if (runQueueWorker) {
  startQueueWorker();
}
startLocalHeartbeat();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    terminateChildren(signal);
  });
}
