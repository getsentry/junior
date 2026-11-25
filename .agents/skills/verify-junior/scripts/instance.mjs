#!/usr/bin/env node
// Start, check, and stop the one Junior dev server (`pnpm dev`) of a
// verification run.
//
// Usage:
//   node instance.mjs launch [--mock] [--run-dir DIR]
//       Create an empty database and Redis database for the run, start
//       `pnpm dev` on them, wait until it is ready, and print the run
//       directory on the last line. `--mock` sets
//       JUNIOR_DASHBOARD_MOCK_CONVERSATIONS=true. DIR defaults to
//       ${TMPDIR:-/tmp}/verify-junior/<UTC time>-<pid>. Every error, span,
//       and log that Nitro sends goes to the run's Sentry Local receiver
//       and DIR/telemetry.ndjson.
//   node instance.mjs doctor RUN_DIR
//       Read-only. Exit 0 only when the instance of RUN_DIR is safe to drive.
//   node instance.mjs crash-worker RUN_DIR [--when FILE]
//       Make Nitro replace the app worker of this run, the way a code change
//       does. This ends a running Turn as a crash does. `--when` waits until
//       FILE exists first, for example the snapshot of a running Turn.
//   node instance.mjs stop RUN_DIR
//       Stop what launch started, and drop the run's databases. Keep RUN_DIR
//       and its evidence.
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: import.meta.dirname,
  encoding: "utf8",
}).trim();
const baseUrl = "http://localhost:3000";
// `pnpm dev` binds 3000 (dashboard and API), and the run's Sentry Local
// receiver binds 8970. Both are fixed, so only one instance can run on a
// machine. 8970 keeps the receiver off 8969, where the Local daemon that a
// plain `pnpm dev` uses can stay up after it exits.
const sentryLocalPort = "8970";
const ports = [3000, Number(sentryLocalPort)];
const sentryCli = join(repoRoot, "node_modules/sentry/dist/bin.cjs");

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

// Verification scaffolding: each run gets its own Postgres database and Redis
// database in the compose services, so it starts empty and its cleanup cannot
// touch the developer's data in `junior` and Redis database 0.
const psql = (sql) =>
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "junior",
      "-d",
      "junior",
      "-v",
      "ON_ERROR_STOP=1",
      "-tAc",
      sql,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();
const redis = (db, ...args) =>
  execFileSync(
    "docker",
    ["compose", "exec", "-T", "redis", "redis-cli", "-n", String(db), ...args],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim();

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

/** Parent pid of each running process. `ps` works on Linux and macOS. */
function parents() {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
  });
  return new Map(
    out
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number)),
  );
}

function descendants(pid, parentOf = parents()) {
  const children = [...parentOf]
    .filter(([, ppid]) => ppid === pid)
    .map(([child]) => child);
  return children.flatMap((child) => [child, ...descendants(child, parentOf)]);
}

/** The pid that listens on a TCP port, or undefined. */
function listenerOf(port) {
  try {
    // macOS, and Linux hosts with lsof. lsof exits 1 when nothing listens.
    const out = execFileSync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      {
        encoding: "utf8",
      },
    );
    return Number(out.split("\n")[0]) || undefined;
  } catch (error) {
    if (error.code !== "ENOENT") return undefined;
  }
  // Linux without lsof: map the listening socket inode to its process.
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
      // lstat, not existsSync: existsSync follows the link and misses a
      // link whose target is gone.
      try {
        if (lstatSync(dist).isSymbolicLink()) rmSync(dist);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
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

  execFileSync(
    "docker",
    ["compose", "up", "-d", "--wait", "postgres", "redis"],
    {
      cwd: repoRoot,
      stdio: "ignore",
    },
  );
  const database = `verify_junior_${basename(runDir).replace(/\W/g, "_").toLowerCase()}`;
  psql(`CREATE DATABASE "${database}"`);
  writeFileSync(join(runDir, "database.txt"), database);
  const redisDb = [...Array(15).keys()]
    .map((i) => i + 1)
    .find((db) => redis(db, "DBSIZE") === "0");
  if (!redisDb) throw new Error("no empty Redis database in 1-15");
  writeFileSync(join(runDir, "redis-db.txt"), String(redisDb));

  const env = { ...process.env };
  env["DATABASE_URL"] = `postgres://junior:junior@localhost:54322/${database}`;
  env["REDIS_URL"] = `redis://localhost:6382/${redisDb}`;
  env["JUNIOR_STATE_ADAPTER"] = "redis";
  // A disposable key for this run only. Never write it to a file.
  env["JUNIOR_ENCRYPTION_KEYS"] ||=
    `k1:${randomBytes(32).toString("base64url")}`;
  if (mock) env["JUNIOR_DASHBOARD_MOCK_CONVERSATIONS"] = "true";
  if (!(await startTelemetry(runDir)))
    return failLaunch(
      runDir,
      `Sentry Local did not listen on ${sentryLocalPort}; see ${join(runDir, "telemetry.log")}`,
    );
  // With `SENTRY_SPOTLIGHT` set, `pnpm dev` sends to the run's receiver and
  // starts no Sentry Local of its own.
  env["SENTRY_SPOTLIGHT"] = `http://localhost:${sentryLocalPort}/stream`;
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
      return failLaunch(
        runDir,
        `pnpm dev exited; see ${join(runDir, "dev.log")}`,
      );
    if ((await status("/")) === 200 && (await status("/api/health")) === 200) {
      console.log(`ready: ${baseUrl} (mock=${mock})`);
      console.log(runDir);
      return 0;
    }
    await sleep(5000);
  }
  return failLaunch(
    runDir,
    `not ready after 10 minutes; see ${join(runDir, "dev.log")}`,
  );
}

// Start the run's own Sentry Local receiver, which writes every event that
// Nitro sends as NDJSON. It starts before `pnpm dev`, so it misses none.
// Resolves false when the receiver does not listen.
async function startTelemetry(runDir) {
  const out = openSync(join(runDir, "telemetry.ndjson"), "a");
  const err = openSync(join(runDir, "telemetry.log"), "a");
  const child = spawn(
    process.execPath,
    [
      sentryCli,
      "local",
      "serve",
      "--port",
      sentryLocalPort,
      "--format",
      "json",
      "--attributes",
    ],
    { cwd: repoRoot, detached: true, stdio: ["ignore", out, err] },
  );
  writeFileSync(join(runDir, "telemetry.pid"), String(child.pid));
  child.unref();
  for (let i = 0; i < 30 && alive(child.pid); i++) {
    if (await portInUse(Number(sentryLocalPort))) return true;
    await sleep(500);
  }
  return false;
}

// A failed launch stops what it started, so that the ports are free again.
async function failLaunch(runDir, message) {
  console.error(message);
  // stderr: the last stdout line of launch is the run directory.
  await stop(runDir, console.error);
  return 1;
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
  const parentOf = parents();
  let ancestor = listener;
  while (ancestor && ancestor > 1 && ancestor !== pid)
    ancestor = parentOf.get(ancestor);
  check(
    `port 3000 is owned by this run (pid ${listener})`,
    !listener
      ? "nothing listens on 3000"
      : ancestor === pid
        ? undefined
        : `pid ${listener} does not descend from ${pid}`,
  );

  const telemetryPid = Number(
    readFileSync(join(runDir, "telemetry.pid"), "utf8"),
  );
  check(
    `telemetry tail ${telemetryPid} writes telemetry.ndjson`,
    alive(telemetryPid) ? undefined : "not running",
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
  const servesMock = versions.includes('"inboxItems":"mock"');
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
  const database = readFileSync(join(runDir, "database.txt"), "utf8");
  let found = "";
  try {
    found = psql(`SELECT 1 FROM pg_database WHERE datname = '${database}'`);
  } catch {
    // Reported by the check below.
  }
  check(
    `run database ${database} exists`,
    found === "1" ? undefined : "missing",
  );

  for (const [name, problem] of results)
    console.log(problem ? `FAIL  ${name}: ${problem}` : `ok    ${name}`);
  return results.some(([, problem]) => problem) ? 1 : 0;
}

async function stop(runDir, log = console.log) {
  // A launch whose receiver failed did not start `pnpm dev`.
  const pid = existsSync(join(runDir, "dev.pid"))
    ? Number(readFileSync(join(runDir, "dev.pid"), "utf8"))
    : undefined;
  if (pid && alive(pid)) {
    // `pnpm dev` puts some children in their own process groups, so a group
    // signal misses them. Signal the recorded tree only, never by name.
    const tree = [pid, ...descendants(pid)];
    for (const p of tree) if (alive(p)) process.kill(p, "SIGTERM");
    for (let i = 0; i < 30 && tree.some(alive); i++) await sleep(1000);
    for (const p of tree) if (alive(p)) process.kill(p, "SIGKILL");
    log(`stopped pnpm dev ${pid} and its children`);
  }
  if (existsSync(join(runDir, "telemetry.pid"))) {
    const tail = Number(readFileSync(join(runDir, "telemetry.pid"), "utf8"));
    if (alive(tail)) process.kill(tail, "SIGTERM");
  }
  // A launch that failed early has no databases yet.
  if (existsSync(join(runDir, "database.txt"))) {
    const database = readFileSync(join(runDir, "database.txt"), "utf8");
    psql(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    log(`dropped database ${database}`);
  }
  if (existsSync(join(runDir, "redis-db.txt"))) {
    const redisDb = readFileSync(join(runDir, "redis-db.txt"), "utf8");
    redis(redisDb, "FLUSHDB");
    log(`flushed Redis database ${redisDb}`);
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
    log(`stopped compose ${service}`);
  }
  removeInjectedDistLinks();
  log(`evidence kept in ${join(runDir, "evidence")}`);
  return 0;
}

async function crashWorker(runDir, args) {
  const at = args.indexOf("--when");
  if (at >= 0) {
    for (let i = 0; !existsSync(args[at + 1]); i++) {
      if (i >= 600)
        throw new Error(`${args[at + 1]} did not appear in 10 minutes`);
      await sleep(500);
    }
  }
  const devLog = join(runDir, "dev.log");
  const logStart = readFileSync(devLog, "utf8").length;
  // Nitro builds the app again and replaces its worker when an app file
  // changes. A new mtime is enough, and it leaves no diff.
  const now = new Date();
  utimesSync(join(repoRoot, "apps/example/server.ts"), now, now);
  for (let i = 0; i < 60; i++) {
    if (readFileSync(devLog, "utf8").slice(logStart).includes("Server built")) {
      console.log("Nitro replaced the app worker");
      return 0;
    }
    await sleep(1000);
  }
  throw new Error("Nitro did not rebuild the app in 60 seconds");
}

const [command, ...args] = process.argv.slice(2);
const commands = {
  "crash-worker": () => crashWorker(args[0], args.slice(1)),
  doctor: () => doctor(args[0]),
  launch: () => launch(args),
  stop: () => stop(args[0]),
};
if (!commands[command] || (command !== "launch" && !args[0])) {
  console.error(
    "usage: instance.mjs launch [--mock] [--run-dir DIR] | doctor RUN_DIR | crash-worker RUN_DIR [--when FILE] | stop RUN_DIR",
  );
  process.exit(2);
}
process.exitCode = await commands[command]();
