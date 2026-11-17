#!/usr/bin/env node
// Start, check, and stop the one Junior dev server (`pnpm dev`) of a
// verification run.
//
// Usage:
//   node instance.mjs launch [--mock] [--run-dir DIR]
//       Start `pnpm dev`, wait until it is ready, and print the run
//       directory on the last line. `--mock` sets
//       JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true. DIR defaults to
//       ${TMPDIR:-/tmp}/verify-junior/<UTC time>-<pid>.
//   node instance.mjs doctor RUN_DIR
//       Read-only. Exit 0 only when the instance of RUN_DIR is safe to drive.
//   node instance.mjs stop RUN_DIR
//       Stop what launch started. Keep RUN_DIR and its evidence.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim();
const baseUrl = "http://localhost:3000";
// `pnpm dev` binds 3000 (dashboard and API) and 8969 (Sentry Local UI).
// Both are fixed, so only one instance can run on a machine.
const ports = [3000, 8969];

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();

function runningComposeServices() {
  return execFileSync(
    "docker",
    ["compose", "ps", "--status", "running", "--services"],
    { cwd: repoRoot, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function status(path) {
  try {
    return (
      await fetch(new URL(path, baseUrl), { signal: AbortSignal.timeout(5000) })
    ).status;
  } catch {
    return 0;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parentOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // The second field is the command in parentheses, and it can have spaces.
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
}

function descendants(pid) {
  const children = readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map(Number)
    .filter((child) => {
      try {
        return parentOf(child) === pid;
      } catch {
        return false;
      }
    });
  return children.flatMap((child) => [child, ...descendants(child)]);
}

/** The pid that listens on a TCP port, from /proc, or undefined. */
function listenerOf(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set(
    ["/proc/net/tcp", "/proc/net/tcp6"]
      .flatMap((file) => readFileSync(file, "utf8").split("\n").slice(1))
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols[1]?.endsWith(`:${hex}`) && cols[3] === "0A")
      .map((cols) => `socket:[${cols[9]}]`),
  );
  for (const entry of readdirSync("/proc").filter((e) => /^\d+$/.test(e))) {
    try {
      for (const fd of readdirSync(`/proc/${entry}/fd`)) {
        if (inodes.has(readlinkSync(`/proc/${entry}/fd/${fd}`)))
          return Number(entry);
      }
    } catch {
      // The process ended, or it belongs to another user.
    }
  }
  return undefined;
}

// Verification scaffolding: `pnpm dev` replaces the `dist` of each injected
// workspace package with a symlink to the workspace build. Until the links go,
// `pnpm build` (and so the next `pnpm dev` or `pnpm test:e2e:dashboard`) fails
// with ERR_PNPM_INJECTED_DEPS_SYNC_READ_DIR. `pnpm dev` links them again.
function removeInjectedDistLinks() {
  const store = join(repoRoot, "node_modules/.pnpm");
  for (const entry of readdirSync(store).filter((e) =>
    e.startsWith("@sentry+junior"),
  )) {
    const scope = join(store, entry, "node_modules/@sentry");
    if (!existsSync(scope)) continue;
    for (const name of readdirSync(scope)) {
      const dist = join(scope, name, "dist");
      if (existsSync(dist) && lstatSync(dist).isSymbolicLink()) rmSync(dist);
    }
  }
}

async function launch(args) {
  const mock = args.includes("--mock");
  const at = args.indexOf("--run-dir");
  const runDir =
    at >= 0
      ? args[at + 1]
      : join(
          process.env["TMPDIR"] ?? tmpdir(),
          "verify-junior",
          `${new Date().toISOString().replace(/[-:]|\.\d+/g, "")}-${process.pid}`,
        );
  for (const port of ports) {
    if (await portInUse(port)) {
      throw new Error(
        `port ${port} is in use; this skill drives only an instance that it started`,
      );
    }
  }
  mkdirSync(join(runDir, "evidence"), { recursive: true });
  // stop runs only the compose services that were not running before.
  writeFileSync(
    join(runDir, "compose-before.txt"),
    runningComposeServices().join("\n"),
  );
  writeFileSync(join(runDir, "revision.txt"), git("rev-parse", "HEAD"));
  writeFileSync(join(runDir, "mock.txt"), String(mock));
  removeInjectedDistLinks();

  const env = { ...process.env };
  // A disposable key for this run only. Never write it to a file.
  env["JUNIOR_ENCRYPTION_KEYS"] ||=
    `k1:${randomBytes(32).toString("base64url")}`;
  if (mock) env["JUNIOR_DASHBOARD_MOCK_CONVERSATIONS"] = "true";
  const log = openSync(join(runDir, "dev.log"), "a");
  const child = spawn("pnpm", ["dev"], {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: ["ignore", log, log],
  });
  writeFileSync(join(runDir, "dev.pid"), String(child.pid));
  child.unref();

  // Compose, the package build, and migrations run before Nitro listens.
  // Ready means the dashboard shell and the health report both answer.
  for (let i = 0; i < 120; i++) {
    if (!alive(child.pid))
      throw new Error(`pnpm dev exited; see ${join(runDir, "dev.log")}`);
    if ((await status("/")) === 200 && (await status("/api/health")) === 200) {
      console.log(`ready: ${baseUrl} (mock=${mock})`);
      console.log(runDir);
      return 0;
    }
    await sleep(5000);
  }
  throw new Error(`not ready after 10 minutes; see ${join(runDir, "dev.log")}`);
}

async function doctor(runDir) {
  const results = [];
  const check = (name, problem) => results.push([name, problem]);
  const pid = Number(readFileSync(join(runDir, "dev.pid"), "utf8"));
  check(
    `pnpm dev process ${pid} is up`,
    alive(pid) ? undefined : "not running",
  );

  const listener = listenerOf(3000);
  let ancestor = listener;
  while (ancestor && ancestor > 1 && ancestor !== pid)
    ancestor = parentOf(ancestor);
  check(
    `port 3000 is owned by this run (pid ${listener})`,
    !listener
      ? "nothing listens on 3000"
      : ancestor === pid
        ? undefined
        : `pid ${listener} does not descend from ${pid}`,
  );

  const health = await status("/api/health");
  check(
    "GET /api/health is 200",
    health === 200 ? undefined : `HTTP ${health}`,
  );

  const mock = readFileSync(join(runDir, "mock.txt"), "utf8") === "true";
  let versions = "";
  try {
    versions = await (await fetch(new URL("/api/versions", baseUrl))).text();
  } catch {
    // Reported by the check below.
  }
  const servesMock = versions.includes('"reviewItems":"mock"');
  check(
    `dashboard serves ${mock ? "mock" : "live"} data`,
    servesMock === mock
      ? undefined
      : `launched with mock=${mock}, but /api/versions says otherwise`,
  );

  const head = git("rev-parse", "HEAD");
  check(
    `checkout is still at the launched revision ${head.slice(0, 12)}`,
    head === readFileSync(join(runDir, "revision.txt"), "utf8")
      ? undefined
      : "HEAD moved; restart the run",
  );

  const running = runningComposeServices();
  for (const service of ["postgres", "redis"]) {
    check(
      `compose ${service} is running`,
      running.includes(service) ? undefined : "not running",
    );
  }

  for (const [name, problem] of results)
    console.log(problem ? `FAIL  ${name}: ${problem}` : `ok    ${name}`);
  return results.some(([, problem]) => problem) ? 1 : 0;
}

async function stop(runDir) {
  const pid = Number(readFileSync(join(runDir, "dev.pid"), "utf8"));
  if (alive(pid)) {
    // `pnpm dev` puts some children in their own process groups, so a group
    // signal misses them. Signal the recorded tree only, never by name.
    const tree = [pid, ...descendants(pid)];
    for (const p of tree) if (alive(p)) process.kill(p, "SIGTERM");
    for (let i = 0; i < 30 && tree.some(alive); i++) await sleep(1000);
    for (const p of tree) if (alive(p)) process.kill(p, "SIGKILL");
    console.log(`stopped pnpm dev ${pid} and its children`);
  }
  const before = readFileSync(join(runDir, "compose-before.txt"), "utf8").split(
    "\n",
  );
  for (const service of runningComposeServices().filter(
    (s) => !before.includes(s),
  )) {
    execFileSync("docker", ["compose", "stop", service], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    console.log(`stopped compose ${service}`);
  }
  removeInjectedDistLinks();
  console.log(`evidence kept in ${join(runDir, "evidence")}`);
  return 0;
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  doctor: () => doctor(args[0]),
  launch: () => launch(args),
  stop: () => stop(args[0]),
};
if (!commands[command] || (command !== "launch" && !args[0])) {
  console.error(
    "usage: instance.mjs launch [--mock] [--run-dir DIR] | doctor RUN_DIR | stop RUN_DIR",
  );
  process.exit(2);
}
process.exitCode = await commands[command]();
