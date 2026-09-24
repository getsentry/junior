import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  cleanupTunnel,
  createTunnel,
  installCloudflared,
  runWithTunnel,
} from "./cloudflare-tunnel.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-tunnel-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GITHUB_ACTIONS: "false",
    RUNNER_TEMP: dir,
    CLOUDFLARE_API_TOKEN: "management-secret",
    CLOUDFLARE_ACCOUNT_ID: "test-account",
    CLOUDFLARE_ZONE_ID: "test-zone",
    CLOUDFLARE_TUNNEL_BASE_DOMAIN: "example.com",
    TUNNEL_TOKEN: "must-not-reach-child",
    GITHUB_RUN_ID: "42",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "integration",
    JUNIOR_EVAL_SHARD: "1",
  };
  const tunnels = new Map();
  const records = new Map();
  const configs = [];
  let failDns = false;
  let failCleanup = false;
  let serial = 0;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(options.headers.authorization, "Bearer management-secret");
    const body = options.body ? JSON.parse(options.body) : undefined;
    const resource = url.pathname.replace("/client/v4", "");
    let result;
    if (
      resource === "/accounts/test-account/cfd_tunnel" &&
      options.method === "POST"
    ) {
      assert.equal(body.config_src, "cloudflare");
      result = {
        id: `tunnel-${++serial}`,
        name: body.name,
        token: "connector-secret",
      };
      tunnels.set(result.id, result);
    } else if (resource.endsWith("/configurations")) {
      configs.push(body);
      result = {};
    } else if (
      resource === "/zones/test-zone/dns_records" &&
      options.method === "POST"
    ) {
      assert.equal(body.type, "CNAME");
      assert.equal(body.proxied, true);
      result = { id: `dns-${++serial}`, ...body };
      records.set(result.id, result);
      // The server applied a write but the caller lost its response.
      if (failDns) throw new Error("DNS response lost");
    } else if (options.method === "GET" && resource.endsWith("/dns_records")) {
      result = [...records.values()].filter(
        (r) => r.name === url.searchParams.get("name"),
      );
    } else if (options.method === "GET" && resource.endsWith("/cfd_tunnel")) {
      result = [...tunnels.values()].filter(
        (r) => r.name === url.searchParams.get("name"),
      );
    } else if (options.method === "DELETE") {
      const id = resource.split("/").at(-1);
      if (resource.includes("/dns_records/")) {
        if (failCleanup) return new Response("unavailable", { status: 503 });
        records.delete(id);
      } else if (!resource.endsWith("/connections")) tunnels.delete(id);
      result = {};
    } else {
      throw new Error(`Unexpected request: ${options.method} ${url}`);
    }
    return Response.json({ success: true, result });
  });
  const binary = path.join(dir, "cloudflared");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
assert.equal(process.env.TUNNEL_TOKEN, undefined);
const tokenFile = process.argv[process.argv.indexOf('--token-file') + 1];
assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'connector-secret');
fs.writeFileSync(${JSON.stringify(path.join(dir, "connector-ready"))}, 'ready');
setInterval(() => {}, 1000);
`,
  );
  await chmod(binary, 0o700);
  env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return {
    dir,
    env,
    tunnels,
    records,
    configs,
    failCleanup: (value) => {
      failCleanup = value;
    },
    failDns: () => {
      failDns = true;
    },
  };
}

test("omits management credentials from the child environment and cleans up success and failure", async (t) => {
  const f = await fixture(t);
  for (const code of [0, 7]) {
    const result = await runWithTunnel(
      [
        process.execPath,
        "-e",
        `
      const assert = require('node:assert/strict');
      assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(process.env.TUNNEL_TOKEN, undefined);
      assert.equal(process.env.JUNIOR_EVAL_EGRESS_PORT, '18787');
      assert.match(new URL(process.env.JUNIOR_EVAL_EGRESS_URL).hostname, /^sentry-ci-[a-f0-9]{24}\\.example\\.com$/);
      const fs = require('node:fs');
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(path.join(f.dir, "connector-ready"))})) {
          clearInterval(timer); process.exit(${code});
        }
      }, 10);
    `,
      ],
      f.env,
    );
    assert.equal(result, code);
    assert.equal(f.tunnels.size, 0);
    assert.equal(f.records.size, 0);
    assert.equal(
      (await readdir(f.dir)).some(
        (file) => file.endsWith(".token") || file.endsWith(".json"),
      ),
      false,
    );
    await rm(path.join(f.dir, "connector-ready"));
  }
  assert.deepEqual(
    f.configs[0].config.ingress.map((rule) => rule.service),
    ["http://127.0.0.1:18787", "http_status:404"],
  );
  await cleanupTunnel(f.env); // The Actions fallback step is safe after normal cleanup.
});

test("isolates overlapping allocations and recovers a lost DNS create response", async (t) => {
  const f = await fixture(t);
  const otherDir = path.join(f.dir, "other");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(otherDir);
  const otherEnv = { ...f.env, RUNNER_TEMP: otherDir };
  const first = await createTunnel(f.env);
  const second = await createTunnel(otherEnv);
  assert.notEqual(first.baseUrl, second.baseUrl);
  assert.equal((await stat(first.tokenFile)).mode & 0o777, 0o600);
  await cleanupTunnel(f.env);
  assert.equal(f.tunnels.size, 1);
  assert.equal(
    [...f.records.values()][0].name,
    new URL(second.baseUrl).hostname,
  );
  await cleanupTunnel(otherEnv);
  f.failDns();
  await assert.rejects(createTunnel(f.env), /DNS response lost/);
  assert.equal(f.tunnels.size, 0);
  assert.equal(f.records.size, 0);
});

test("cleanup removes the tunnel even if DNS deletion fails and can resume", async (t) => {
  const f = await fixture(t);
  const tunnel = await createTunnel(f.env);
  f.failCleanup(true);
  await assert.rejects(cleanupTunnel(f.env), /Cleanup failed/);
  assert.equal(f.tunnels.size, 0);
  assert.equal(f.records.size, 1);
  await assert.rejects(stat(tunnel.tokenFile), { code: "ENOENT" });
  await stat(path.join(f.dir, "junior-eval-tunnel.json"));
  f.failCleanup(false);
  await cleanupTunnel(f.env);
  assert.equal(f.records.size, 0);
});

test("cleanup rejects edited targets and state from another job before deletion", async (t) => {
  const f = await fixture(t);
  const tunnel = await createTunnel(f.env);
  const file = path.join(f.dir, "junior-eval-tunnel.json");
  const original = await readFile(file, "utf8");
  const saved = JSON.parse(original);
  const victim = path.join(f.dir, "unrelated-file");
  await writeFile(victim, "keep");
  const requests = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Invalid state must not make an API request");
  });
  for (const edit of [
    { hostname: "production.example.com" },
    { name: `sentry-ci-${"a".repeat(24)}` },
    { accountId: "other-account", zoneId: "other-zone" },
    { tokenFile: victim },
  ]) {
    await writeFile(
      file,
      JSON.stringify({ ...saved, state: { ...saved.state, ...edit } }),
    );
    await assert.rejects(
      cleanupTunnel(f.env),
      /Invalid eval tunnel cleanup state/,
    );
    assert.equal(await readFile(victim, "utf8"), "keep");
    await stat(tunnel.tokenFile);
  }
  await writeFile(file, original);
  await assert.rejects(
    cleanupTunnel({ ...f.env, GITHUB_RUN_ATTEMPT: "2" }),
    /Invalid eval tunnel cleanup state/,
  );
  assert.equal(requests.mock.callCount(), 0);
  requests.mock.restore();
  await cleanupTunnel(f.env);
  assert.equal(f.records.size, 0);
  assert.equal(f.tunnels.size, 0);
});

test("connector failure stops the eval command and cleans up", async (t) => {
  const f = await fixture(t);
  await writeFile(
    path.join(f.dir, "cloudflared"),
    "#!/usr/bin/env node\nprocess.exit(1);\n",
  );
  await assert.rejects(
    runWithTunnel(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      f.env,
    ),
    (error) =>
      error.errors.some((cause) =>
        cause.message.includes("cloudflared exited"),
      ),
  );
  assert.equal(f.tunnels.size, 0);
  assert.equal(f.records.size, 0);
});

test("SIGTERM stops the child and removes its tunnel", async (t) => {
  const f = await fixture(t);
  const running = runWithTunnel(
    [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    f.env,
  );
  // Wait for the real subprocess to start before sending the wrapper a signal.
  const deadline = Date.now() + 5_000;
  while (!(await readdir(f.dir)).includes("connector-ready")) {
    assert.ok(Date.now() < deadline, "connector did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.emit("SIGTERM");
  assert.equal(await running, 130);
  assert.equal(f.tunnels.size, 0);
  assert.equal(f.records.size, 0);
});

test("latest installer checks the exact release asset digest before making it executable", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "eval-install-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("official-release-fixture");
  let digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/releases/latest"))
      return Response.json({
        tag_name: "2026.test",
        assets: [
          {
            name: "cloudflared-linux-amd64",
            digest,
            browser_download_url:
              "https://github.com/cloudflare/cloudflared/releases/download/2026.test/cloudflared-linux-amd64",
          },
        ],
      });
    assert.ok(url.includes("/download/2026.test/"));
    return new Response(bytes);
  });
  const env = { RUNNER_TEMP: dir, GITHUB_PATH: path.join(dir, "github-path") };
  await installCloudflared(env);
  assert.deepEqual(
    await readFile(path.join(dir, "junior-cloudflared/cloudflared")),
    bytes,
  );
  digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(installCloudflared(env), /SHA-256 mismatch/);
});
