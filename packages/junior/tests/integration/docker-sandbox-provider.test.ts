import nodeHttp from "node:http";
import net from "node:net";
import tls from "node:tls";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { dockerJson } from "@/chat/sandbox/docker/api";
import { dockerSandboxProvider } from "@/chat/sandbox/docker/provider";
import { egressCaPem } from "@/chat/sandbox/docker/egress";
import { RELAY_PROXY_HOST, usesEgressRelay } from "@/chat/sandbox/docker/relay";
import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress/policy";
import { createSandboxEgressCredentialToken } from "@/chat/sandbox/egress/session";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { stopSession, type SandboxSession } from "@/chat/sandbox/workspace";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { mswServer } from "../msw/server";

/** Credentialed domain. Its upstream is the echo handler below. */
const CREDENTIAL_DOMAIN = "httpbin.org";
/** Trace-only domain. Its upstream is the echo handler below. */
const TRACE_DOMAIN = "postman-echo.com";
/** A domain outside the policy. Its traffic must pass through untouched. */
const OTHER_DOMAIN = "example.com";
const TRACE_HEADERS = {
  "sentry-trace": "0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
};
const SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;
/** The first run builds the runtime image with `dnf`. */
const LIVE_TEST_TIMEOUT_MS = 10 * 60 * 1000;

const echoSchema = z.object({ headers: z.record(z.string(), z.string()) });

function echo({ request }: { request: Request }) {
  return HttpResponse.json({
    headers: Object.fromEntries(request.headers.entries()),
  });
}

async function curlJson(session: SandboxSession, url: string) {
  const result = await session.runCommand({
    cmd: "curl",
    args: ["-sS", "--fail-with-body", "--max-time", "30", url],
  });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return echoSchema.parse(JSON.parse(result.stdout)).headers;
}

/** Return the port of this process's egress proxy for one sandbox. */
async function proxyPort(session: SandboxSession): Promise<number> {
  if (usesEgressRelay()) {
    const relay = await dockerJson<{
      Config: { Labels: Record<string, string> };
    }>({
      path: `/containers/${session.sandboxId}-egress/json`,
    });
    return Number(relay.Config.Labels["dev.junior.sandbox.relay-target"]);
  }
  const rules = await session.runCommand({
    cmd: "sudo",
    args: ["iptables", "-t", "nat", "-S", "JUNIOR_EGRESS"],
  });
  return Number(/--to-destination [\d.]+:(\d+)/.exec(rules.stdout)?.[1]);
}

/** Hosts that name loopback, link-local, and private addresses. */
const PRIVATE_HOSTS = [
  "localhost",
  "127.0.0.1",
  "169.254.169.254",
  "10.0.0.1",
  "172.16.0.1",
  "192.168.0.1",
];

/**
 * Run `fn` while a service listens on this host's loopback port 80. Return
 * how many requests reached it. When this user cannot listen on port 80, run
 * `fn` without the service.
 */
async function countLoopbackHits(fn: () => Promise<void>): Promise<number> {
  let hits = 0;
  const server = nodeHttp.createServer((_req, res) => {
    hits += 1;
    res.end();
  });
  await new Promise((resolve) => {
    server.once("listening", resolve);
    server.once("error", resolve);
    server.listen(80, "127.0.0.1");
  });
  try {
    await fn();
  } finally {
    server.close();
  }
  return hits;
}

/**
 * Send one credentialed request straight to the proxy from this process,
 * which is not a sandbox. Return what the proxy sent back.
 */
async function unauthenticatedProxyReply(port: number): Promise<string> {
  const socket = usesEgressRelay()
    ? // A relay client that trusts the proxy but has no client certificate.
      tls.connect({
        host: "127.0.0.1",
        port,
        servername: RELAY_PROXY_HOST,
        ca: await egressCaPem(),
      })
    : // A direct client from an address that is not a sandbox.
      net.connect({ host: "127.0.0.1", port });
  let reply = "";
  socket.on("data", (chunk: Buffer) => (reply += chunk.toString()));
  // A rejected client sees a TLS alert or a reset. Only the reply matters.
  socket.on("error", () => undefined);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.write(
    `GET /anything HTTP/1.1\r\nHost: ${CREDENTIAL_DOMAIN}\r\nConnection: close\r\n\r\n`,
  );
  await closed;
  return reply;
}

/**
 * Prove the Docker sandbox provider against a real Docker daemon.
 *
 * It needs a Docker daemon and network access, and its first run builds the
 * runtime image. Set `JUNIOR_DOCKER_SANDBOX_TEST=1` to run it.
 */
describe.skipIf(!process.env.JUNIOR_DOCKER_SANDBOX_TEST)(
  "Docker sandbox provider",
  () => {
    beforeAll(async () => {
      const { createApp, defineJuniorPlugins } = await import("@/app");
      await createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "docker-egress",
              displayName: "Docker Egress",
              description: "Docker sandbox egress fixture",
              domains: [CREDENTIAL_DOMAIN],
            },
            hooks: {
              grantForEgress: () => ({
                name: "installation-read",
                access: "read",
                reason: "docker.read",
              }),
              issueCredential: () => ({
                type: "lease",
                lease: {
                  expiresAt: new Date(Date.now() + 60_000).toISOString(),
                  headerTransforms: [
                    {
                      domain: CREDENTIAL_DOMAIN,
                      headers: { Authorization: "Bearer docker-egress-test" },
                    },
                  ],
                },
              }),
            },
          }),
        ]),
        waitUntil(task) {
          if (typeof task === "function") void task();
        },
      });
      await getStateAdapter().connect();
    });

    afterAll(async () => {
      await disconnectStateAdapter();
    });

    it(
      "runs commands, keeps files across resume and snapshot, and routes egress",
      async () => {
        mswServer.use(
          http.all(`https://${CREDENTIAL_DOMAIN}/*`, echo),
          http.all(`https://${TRACE_DOMAIN}/*`, echo),
        );
        const sessions: SandboxSession[] = [];
        try {
          const session = await dockerSandboxProvider.createSession({
            runtime: SANDBOX_RUNTIME,
            timeoutMs: SANDBOX_TIMEOUT_MS,
          });
          sessions.push(session);
          await session.writeFiles([{ path: "notes/a.txt", content: "kept" }]);
          const resumed = await dockerSandboxProvider.getSession({
            name: session.sandboxId,
          });
          expect(
            String(await resumed.readFileToBuffer({ path: "notes/a.txt" })),
          ).toBe("kept");

          // Production binds the credential token to the session id after
          // the sandbox exists, then updates the policy.
          await session.update({
            networkPolicy: buildSandboxEgressNetworkPolicy({
              credentialToken: createSandboxEgressCredentialToken({
                credentials: { actor: { type: "user", userId: "U123" } },
                egressId: session.sessionId,
                ttlMs: 60_000,
              }),
              traceConfig: { domains: [TRACE_DOMAIN] },
              traceHeaders: TRACE_HEADERS,
            }),
          });
          const credentialed = await curlJson(
            session,
            `https://${CREDENTIAL_DOMAIN}/anything`,
          );
          expect(credentialed.authorization).toBe("Bearer docker-egress-test");
          const traced = await curlJson(session, `https://${TRACE_DOMAIN}/get`);
          expect(traced).toMatchObject(TRACE_HEADERS);
          expect(traced.authorization).toBeUndefined();

          // Credentials never go upstream over plain HTTP.
          const plain = await session.runCommand({
            cmd: "curl",
            args: [
              "-sS",
              "-o",
              "/dev/null",
              "-w",
              "%{http_code}",
              `http://${CREDENTIAL_DOMAIN}/anything`,
            ],
          });
          expect(plain.stdout).toBe("403");

          // An absolute request target cannot move a credentialed request
          // to another host.
          const retargeted = await session.runCommand({
            cmd: "curl",
            args: [
              "-sS",
              "-o",
              "/dev/null",
              "-w",
              "%{http_code}",
              "--request-target",
              `https://${OTHER_DOMAIN}/`,
              `https://${CREDENTIAL_DOMAIN}/anything`,
            ],
          });
          expect(retargeted.stdout).toBe("400");

          // Only sandboxes, or their relays with a client certificate, can
          // use the proxy.
          expect(
            await unauthenticatedProxyReply(await proxyPort(session)),
          ).toBe("");

          // Pass-through never reaches an address that is not public. The
          // proxy closes the connection, so curl gets no status code. A
          // loopback service on this host counts requests that get through.
          const loopbackHits = await countLoopbackHits(async () => {
            const blocked = await session.runCommand({
              cmd: "sh",
              args: [
                "-c",
                `for host in ${PRIVATE_HOSTS.join(" ")}; do curl -s -o /dev/null -m 5 -w '%{http_code} ' -H "Host: $host" http://${OTHER_DOMAIN}/; done`,
              ],
            });
            expect(blocked.stdout).toBe("000 ".repeat(PRIVATE_HOSTS.length));
          });
          expect(loopbackHits).toBe(0);

          // Other domains keep their real certificate and reach the network.
          const other = await session.runCommand({
            cmd: "curl",
            args: [
              "-sS",
              "-o",
              "/dev/null",
              "-w",
              "%{http_code}",
              `https://${OTHER_DOMAIN}/`,
            ],
          });
          expect(other.stdout).toBe("200");

          const { snapshotId } = await session.snapshot();
          const booted = await dockerSandboxProvider.createSession({
            snapshotId,
            timeoutMs: SANDBOX_TIMEOUT_MS,
          });
          sessions.push(booted);
          expect(
            String(await booted.readFileToBuffer({ path: "notes/a.txt" })),
          ).toBe("kept");
        } finally {
          await Promise.all(sessions.map((session) => stopSession(session)));
        }
      },
      LIVE_TEST_TIMEOUT_MS,
    );
  },
);
