import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { once } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startEvalEgress } from "../../src/eval-egress";

const originalPath = process.env.PATH;
const originalAttemptMarker = process.env.EVAL_EGRESS_ATTEMPT_MARKER;
const originalCloseMarker = process.env.EVAL_EGRESS_CLOSE_MARKER;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalJuniorSecret = process.env.JUNIOR_SECRET;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalAttemptMarker === undefined) {
    delete process.env.EVAL_EGRESS_ATTEMPT_MARKER;
  } else {
    process.env.EVAL_EGRESS_ATTEMPT_MARKER = originalAttemptMarker;
  }
  if (originalCloseMarker === undefined) {
    delete process.env.EVAL_EGRESS_CLOSE_MARKER;
  } else {
    process.env.EVAL_EGRESS_CLOSE_MARKER = originalCloseMarker;
  }
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalJuniorSecret === undefined) delete process.env.JUNIOR_SECRET;
  else process.env.JUNIOR_SECRET = originalJuniorSecret;
});

describe("eval egress", () => {
  it("serves the CI tunnel route on its port without a Quick Tunnel", async () => {
    vi.stubEnv("JUNIOR_EVAL_EGRESS_URL", "https://sentry-ci-test.example.com");
    vi.stubEnv("JUNIOR_EVAL_EGRESS_PORT", "18787");
    // cloudflared must not run: the CI script owns the connector.
    vi.stubEnv("PATH", "");
    const verifiedUrls: string[] = [];
    const egress = await startEvalEgress({
      verifyPublicUrl: async (url) => {
        verifiedUrls.push(url);
      },
    });
    try {
      expect(verifiedUrls).toEqual(["https://sentry-ci-test.example.com"]);
      expect(egress.baseUrl).toBe("https://sentry-ci-test.example.com");
      expect(new URL(egress.controlUrl).port).toBe("18787");
      await expect(
        fetch("http://127.0.0.1:18787/health").then((response) => response.ok),
      ).resolves.toBe(true);
      await expect(
        fetch(egress.stateUrl).then((response) => response.status),
      ).resolves.toBe(401);
    } finally {
      await egress.close();
    }
  });

  it("retries a failed Quick Tunnel allocation through teardown", async () => {
    let resetCount = 0;
    const resetTimes: number[] = [];
    let publicVerificationAttempts = 0;
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "eval-egress-test-"));
    const cloudflaredPath = path.join(fixtureDir, "cloudflared");
    const attemptMarker = path.join(fixtureDir, "attempts");
    const closeMarker = path.join(fixtureDir, "closed");
    await writeFile(
      cloudflaredPath,
      `#!/usr/bin/env node
const fs = require("node:fs/promises");
const target = process.argv[process.argv.indexOf("--url") + 1];
void (async () => {
  const attempt = Number(await fs.readFile(process.env.EVAL_EGRESS_ATTEMPT_MARKER, "utf8").catch(() => "0")) + 1;
  await fs.writeFile(process.env.EVAL_EGRESS_ATTEMPT_MARKER, String(attempt), "utf8");
  if (attempt === 1) {
    process.stderr.write('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded\\n');
    process.exit(1);
    return;
  }
  const [healthResponse, proxyResponse] = await Promise.all([
    fetch(new URL("/health", target)),
    fetch(new URL("/api/internal/sandbox-egress", target)),
  ]);
  if (!healthResponse.ok) process.exit(2);
  if (proxyResponse.status !== 401) process.exit(3);
  const proxyBody = await proxyResponse.json();
  if (proxyBody.error !== "Missing Vercel Sandbox OIDC token") process.exit(4);
  process.stderr.write("https://eval-suite.trycloudflare.com\\n");
  process.stderr.write("Registered tunnel connection\\n");
})();
process.on("SIGTERM", async () => {
  await fs.writeFile(process.env.EVAL_EGRESS_CLOSE_MARKER, "closed", "utf8");
  process.exit(0);
});
setInterval(() => undefined, 1000);
`,
      "utf8",
    );
    await chmod(cloudflaredPath, 0o755);
    process.env.PATH = `${fixtureDir}${path.delimiter}${originalPath ?? ""}`;
    process.env.EVAL_EGRESS_ATTEMPT_MARKER = attemptMarker;
    process.env.EVAL_EGRESS_CLOSE_MARKER = closeMarker;
    process.env.DATABASE_URL =
      "postgres://junior:junior@127.0.0.1:54322/junior";
    process.env.JUNIOR_SECRET = "junior-test-secret";

    try {
      const egress = await startEvalEgress({
        readFixtureState: () => ({ resetCount, resetTimes }),
        resetFixtures: ({ nowMs }) => {
          resetCount += 1;
          resetTimes.push(nowMs);
        },
        verifyPublicUrl: async () => {
          publicVerificationAttempts += 1;
          if (publicVerificationAttempts === 1)
            throw new Error("DNS not ready");
        },
      });
      expect(publicVerificationAttempts).toBe(2);
      await expect(readFile(attemptMarker, "utf8")).resolves.toBe("3");
      expect(egress.baseUrl).toBe("https://eval-suite.trycloudflare.com");
      await expect(
        fetch(egress.controlUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${egress.controlToken}` },
          body: JSON.stringify({ nowMs: 1_000 }),
        }).then((response) => response.status),
      ).resolves.toBe(204);
      await expect(
        fetch(egress.controlUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${egress.controlToken}` },
          body: JSON.stringify({ nowMs: 2_000 }),
        }).then((response) => response.status),
      ).resolves.toBe(204);
      await expect(
        fetch(egress.stateUrl, {
          headers: { authorization: `Bearer ${egress.controlToken}` },
        }).then((response) => response.json()),
      ).resolves.toEqual({ resetCount: 2, resetTimes: [1_000, 2_000] });
      // A disconnected tunnel can leave a partial HTTP request on the proxy.
      const socket = createConnection({
        host: "127.0.0.1",
        port: Number(new URL(egress.controlUrl).port),
      });
      try {
        await once(socket, "connect");
        socket.write("GET /health HTTP/1.1\r\nHost: localhost\r\n");
        const disconnected = once(socket, "close");
        await egress.close();
        await disconnected;
        await expect(egress.close()).resolves.toBeUndefined();
      } finally {
        socket.destroy();
      }
      await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed");
    } finally {
      await rm(fixtureDir, { force: true, recursive: true });
    }
  }, 15_000);
});
