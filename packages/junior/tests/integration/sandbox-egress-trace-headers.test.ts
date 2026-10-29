import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { TracePropagationHeaders } from "@/chat/logging";
import { buildSandboxEgressNetworkPolicy } from "@/chat/sandbox/egress/policy";
import { getSandboxProvider } from "@/chat/sandbox/provider";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { stopSession, type SandboxSession } from "@/chat/sandbox/workspace";

/** Trace-only domain. httpbin echoes the request headers it receives. */
const TRACE_DOMAIN = "httpbin.org";
/** Same echo service on a host that is not in the trace domain list. */
const OTHER_DOMAIN = "www.httpbin.org";
const TRACE_HEADERS = {
  "sentry-trace": "0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-1",
  baggage:
    "sentry-trace_id=0af7651916cd43dd8448eb211c80319c,sentry-environment=sandbox-egress-test",
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
} satisfies TracePropagationHeaders;
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
const LIVE_TEST_TIMEOUT_MS = 3 * 60 * 1000;

function sandboxCredentialsReady(): boolean {
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) return true;
  return Boolean(
    process.env.VERCEL_TOKEN?.trim() &&
    process.env.VERCEL_TEAM_ID?.trim() &&
    process.env.VERCEL_PROJECT_ID?.trim(),
  );
}

const httpbinResponseSchema = z.object({
  headers: z.record(z.string(), z.string()),
});

/**
 * Return the request headers that httpbin saw, with lowercase names.
 *
 * A failed request or an unexpected response throws an "httpbin unavailable"
 * error, so an outage is easy to tell apart from a header mismatch.
 */
async function echoedHeaders(
  session: SandboxSession,
  host: string,
): Promise<Record<string, string>> {
  const url = `https://${host}/anything`;
  const result = await session.runCommand({
    cmd: "curl",
    // `--fail-with-body` makes curl exit non-zero for HTTP errors.
    args: ["-sS", "--fail-with-body", "--max-time", "30", url],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `httpbin unavailable: curl ${url} exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  let parsed: z.infer<typeof httpbinResponseSchema>;
  try {
    parsed = httpbinResponseSchema.parse(JSON.parse(result.stdout));
  } catch {
    throw new Error(
      `httpbin unavailable: ${url} returned an unexpected body: ${result.stdout.slice(0, 200)}`,
    );
  }
  return Object.fromEntries(
    Object.entries(parsed.headers).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
}

/**
 * Prove that a real Vercel Sandbox adds Junior's trace headers on trace-only
 * domains, and only there. Skip this test when Vercel credentials are not
 * available.
 */
describe.skipIf(!sandboxCredentialsReady())(
  "Sandbox egress trace headers",
  () => {
    it(
      "adds trace headers to trace-only domains after a network policy update",
      async () => {
        const traceConfig = { domains: [TRACE_DOMAIN] };
        // Production creates the Sandbox with a policy that has no trace
        // headers, then updates it with each tool call's trace headers.
        const session = await getSandboxProvider().createSession({
          runtime: SANDBOX_RUNTIME,
          timeoutMs: SANDBOX_TIMEOUT_MS,
          networkPolicy: buildSandboxEgressNetworkPolicy({ traceConfig }),
        });
        try {
          await session.update({
            networkPolicy: buildSandboxEgressNetworkPolicy({
              traceConfig,
              traceHeaders: TRACE_HEADERS,
            }),
          });

          expect(await echoedHeaders(session, TRACE_DOMAIN)).toMatchObject(
            TRACE_HEADERS,
          );
          const otherHeaders = await echoedHeaders(session, OTHER_DOMAIN);
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
