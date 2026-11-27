// Regression: `launch` must refuse a Sentry Local receiver that another
// process already holds on IPv6 loopback. Before, the preflight probed only
// 127.0.0.1, the run's receiver attached to the other server as a consumer,
// and that server's events went into the run's telemetry.ndjson.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const instance = join(import.meta.dirname, "instance.mjs");
const sentryCli = join(
  import.meta.dirname,
  "../../../../node_modules/sentry/dist/bin.cjs",
);

function accepts(port, host) {
  return new Promise((resolve) => {
    const socket = connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test("launch refuses a receiver that another process holds on ::1", async (t) => {
  for (const [port, host] of [
    [3000, "127.0.0.1"],
    [3000, "::1"],
    [8970, "127.0.0.1"],
    [8970, "::1"],
  ]) {
    if (await accepts(port, host)) {
      t.skip(`${host}:${port} is already in use`);
      return;
    }
  }
  const other = spawn(
    process.execPath,
    [sentryCli, "local", "serve", "--host", "::1", "--port", "8970", "--quiet"],
    { stdio: "ignore" },
  );
  t.after(() => other.kill());
  for (let i = 0; i < 30 && !(await accepts(8970, "::1")); i++) {
    if (other.exitCode !== null) break;
    await sleep(500);
  }
  if (!(await accepts(8970, "::1"))) {
    t.skip("could not start a receiver on ::1, so this host has no IPv6");
    return;
  }

  const runDir = join(mkdtempSync(join(tmpdir(), "verify-junior-")), "run");
  const launch = spawnSync(
    process.execPath,
    [instance, "launch", "--run-dir", runDir],
    { encoding: "utf8", timeout: 60_000 },
  );

  assert.notEqual(launch.status, 0, launch.stdout);
  assert.match(launch.stderr, /port 8970 is in use/);
  assert.equal(existsSync(join(runDir, "telemetry.ndjson")), false);
});
