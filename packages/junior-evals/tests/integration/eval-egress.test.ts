import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEvalEgress } from "../../src/eval-egress";

const originalPath = process.env.PATH;
const originalCloseMarker = process.env.EVAL_EGRESS_CLOSE_MARKER;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalJuniorSecret = process.env.JUNIOR_SECRET;

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
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
  it("owns one server and retries an unreachable tunnel through teardown", async () => {
    let resetCount = 0;
    let publicVerificationAttempts = 0;
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "eval-egress-test-"));
    const cloudflaredPath = path.join(fixtureDir, "cloudflared");
    const closeMarker = path.join(fixtureDir, "closed");
    await writeFile(
      cloudflaredPath,
      `#!/usr/bin/env node
const fs = require("node:fs/promises");
const target = process.argv[process.argv.indexOf("--url") + 1];
Promise.all([
  fetch(new URL("/health", target)),
  fetch(new URL("/api/internal/sandbox-egress", target)),
]).then(async ([healthResponse, proxyResponse]) => {
  if (!healthResponse.ok) process.exit(2);
  if (proxyResponse.status !== 401) process.exit(3);
  const proxyBody = await proxyResponse.json();
  if (proxyBody.error !== "Missing Vercel Sandbox OIDC token") process.exit(4);
  process.stderr.write("https://eval-suite.trycloudflare.com\\n");
  process.stderr.write("Registered tunnel connection\\n");
});
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
    process.env.EVAL_EGRESS_CLOSE_MARKER = closeMarker;
    process.env.DATABASE_URL =
      "postgres://junior:junior@127.0.0.1:54322/junior";
    process.env.JUNIOR_SECRET = "junior-test-secret";

    try {
      const egress = await startEvalEgress({
        readFixtureState: () => ({ resetCount }),
        resetFixtures: () => {
          resetCount += 1;
        },
        verifyPublicUrl: async () => {
          publicVerificationAttempts += 1;
          if (publicVerificationAttempts === 1) {
            throw new Error("simulated stale Quick Tunnel DNS");
          }
        },
      });
      expect(publicVerificationAttempts).toBe(2);
      expect(egress.baseUrl).toBe("https://eval-suite.trycloudflare.com");
      await expect(
        fetch(egress.controlUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${egress.controlToken}` },
        }).then((response) => response.status),
      ).resolves.toBe(204);
      await expect(
        fetch(egress.controlUrl, {
          method: "POST",
          headers: { authorization: `Bearer ${egress.controlToken}` },
        }).then((response) => response.status),
      ).resolves.toBe(204);
      await expect(
        fetch(egress.stateUrl, {
          headers: { authorization: `Bearer ${egress.controlToken}` },
        }).then((response) => response.json()),
      ).resolves.toEqual({ resetCount: 2 });
      await egress.close();
      await expect(egress.close()).resolves.toBeUndefined();
      await expect(readFile(closeMarker, "utf8")).resolves.toBe("closed");
    } finally {
      await rm(fixtureDir, { force: true, recursive: true });
    }
  });
});
