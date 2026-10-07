/**
 * The recording session of one test.
 *
 * Global setup starts the recording proxy (`src/recording-proxy/`) with the
 * rules of `src/recording-rules.ts`. This module sends all HTTP traffic of
 * the test through the proxy as one session. The fixture mocks, such as
 * Slack, still answer first. When the test passes, the proxy writes the
 * recordings of the session. A failed test writes nothing, so a bad sample
 * is never replayed.
 */
import { randomUUID } from "node:crypto";
import {
  Agent,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  request,
  setGlobalDispatcher,
} from "undici";
import { inject, onTestFinished } from "vitest";
import { installEvalAiGatewayDispatcher } from "../eval-ai-gateway-dispatcher";
import "../eval-context";
import { useGlobalDispatcherForFetch } from "../fetch-dispatcher";
import { NO_PROXY } from "../recording-rules";

/** Send the HTTP traffic of the current test through the recording proxy. */
export function installRecordings(): void {
  const proxy = inject("recordingProxy");
  if (!proxy) return;

  const sessionId = randomUUID();
  const previous = getGlobalDispatcher();
  // One agent per test, so each tunnel carries the session of its test.
  // Other traffic of the worker uses the proxy variables of the run
  // (`src/recording-run.ts`), without a session.
  const agent = new EnvHttpProxyAgent({
    httpProxy: proxy.url,
    httpsProxy: proxy.url,
    noProxy: NO_PROXY,
    token: `Basic ${Buffer.from(`${sessionId}:${proxy.secret}`).toString("base64")}`,
    requestTls: { ca: proxy.caCert },
  });
  setGlobalDispatcher(agent);
  // MSW starts before each test file, so this runs after it.
  useGlobalDispatcherForFetch();
  const restoreTimeouts = installEvalAiGatewayDispatcher();

  onTestFinished(async ({ task }) => {
    // The control API is on the proxy itself, so it must not use the proxy.
    const control = new Agent();
    try {
      const action = task.result?.state === "pass" ? "commit" : "discard";
      const url = `${proxy.url}/__recording-proxy/sessions/${sessionId}/${action}`;
      const response = await request(url, {
        dispatcher: control,
        headers: { authorization: `Bearer ${proxy.secret}` },
        method: "POST",
      });
      await response.body.dump();
      if (response.statusCode >= 400) {
        throw new Error(
          `Recording proxy POST ${url} failed with HTTP ${response.statusCode}`,
        );
      }
    } finally {
      await restoreTimeouts();
      setGlobalDispatcher(previous);
      await agent.close();
      await control.close();
    }
  });
}
