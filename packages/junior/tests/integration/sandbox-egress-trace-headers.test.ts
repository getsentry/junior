import { describe, expect, it } from "vitest";
import * as z from "zod";
import type { TracePropagationHeaders } from "@/chat/logging";
import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress/policy";
import { getSandboxProvider } from "@/chat/sandbox/provider";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { stopSession, type SandboxSession } from "@/chat/sandbox/workspace";

/** Port whose Preview host is the trace-only domain. */
const TRACE_PORT = 3000;
/** Port whose Preview host is not in the trace domain list. */
const OTHER_PORT = 3001;
const ECHO_SERVER_PATH = "/tmp/echo-headers.mjs";
const ECHO_READY_PATH = "/tmp/echo-headers.ready";
/** Reply with the request headers as JSON on both ports. */
const ECHO_SERVER = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
let listening = 0;
for (const port of [${TRACE_PORT}, ${OTHER_PORT}]) {
  createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ headers: request.headers }));
  }).listen(port, "0.0.0.0", () => {
    listening += 1;
    if (listening === 2) writeFileSync("${ECHO_READY_PATH}", "");
  });
}
`;
const TRACE_HEADERS = {
  "sentry-trace": "0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1",
  baggage:
    "sentry-trace_id=0af7651916cd43dd8448eb211c80319c,sentry-environment=sandbox-egress-test",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
} satisfies TracePropagationHeaders;
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
const LIVE_TEST_TIMEOUT_MS = 3 * 60 * 1000;

function sandboxCredentialsReady(): boolean {
  if (process.env["VERCEL_OIDC_TOKEN"]?.trim()) return true;
  return Boolean(
    process.env["VERCEL_TOKEN"]?.trim() &&
    process.env["VERCEL_TEAM_ID"]?.trim() &&
    process.env["VERCEL_PROJECT_ID"]?.trim(),
  );
}

const echoResponseSchema = z.object({
  headers: z.record(z.string(), z.string()),
});

/**
 * Start the echo server in the Sandbox and return once both ports listen.
 * The command fails if the server exits before it is ready.
 */
async function startEchoServer(session: SandboxSession): Promise<void> {
  await session.writeFiles([{ path: ECHO_SERVER_PATH, content: ECHO_SERVER }]);
  const result = await session.runCommand({
    cmd: "sh",
    args: [
      "-c",
      `node ${ECHO_SERVER_PATH} >/tmp/echo-headers.log 2>&1 &
while [ ! -e ${ECHO_READY_PATH} ]; do kill -0 $! || exit 1; sleep 0.05; done`,
    ],
  });
  expect(result.exitCode).toBe(0);
}

/**
 * Return the request headers that the echo server saw through a public
 * Preview URL. The request leaves the Sandbox, so it goes through the network
 * policy like any other outbound request.
 */
async function echoedHeaders(
  session: SandboxSession,
  url: string,
): Promise<Record<string, string>> {
  const result = await session.runCommand({
    cmd: "curl",
    // `--fail-with-body` makes curl exit non-zero for HTTP errors.
    args: ["-sS", "--fail-with-body", "--max-time", "30", url],
  });
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return echoResponseSchema.parse(JSON.parse(result.stdout)).headers;
}

/**
 * Prove that a real Vercel Sandbox adds Junior's trace headers on trace-only
 * domains, and only there. The Sandbox serves its own echo server on two
 * Preview hosts, so the test needs no third-party host. Skip this test when
 * Vercel credentials are not available.
 */
describe.skipIf(!sandboxCredentialsReady())(
  "Sandbox egress trace headers",
  () => {
    it(
      "adds trace headers to trace-only domains after a network policy update",
      async () => {
        const session = await getSandboxProvider().createSession({
          runtime: SANDBOX_RUNTIME,
          timeoutMs: SANDBOX_TIMEOUT_MS,
          networkPolicy: buildSandboxEgressNetworkPolicy(),
        });
        try {
          await startEchoServer(session);
          const traceUrl = await session.createPreview?.(TRACE_PORT);
          const otherUrl = await session.createPreview?.(OTHER_PORT);
          if (!traceUrl || !otherUrl) {
            throw new Error("The Vercel Sandbox did not return Preview URLs");
          }
          const traceConfig = { domains: [new URL(traceUrl).host] };
          // Production creates the Sandbox with a policy that has no trace
          // headers, then updates it with each tool call's trace headers.
          await session.update({
            networkPolicy: buildSandboxEgressNetworkPolicy({
              traceConfig,
              traceHeaders: TRACE_HEADERS,
            }),
          });

          expect(await echoedHeaders(session, traceUrl)).toMatchObject(
            TRACE_HEADERS,
          );
          const otherHeaders = await echoedHeaders(session, otherUrl);
          expect(
            Object.keys(otherHeaders).filter((name) => name in TRACE_HEADERS),
          ).toEqual([]);
        } finally {
          await stopSession(session);
        }
      },
      LIVE_TEST_TIMEOUT_MS,
    );
  },
);
