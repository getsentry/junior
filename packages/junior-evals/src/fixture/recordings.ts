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

/** Send the HTTP traffic of the current test through the recording proxy. */
export function installRecordings(): void {
  const proxy = inject("recordingProxy");
  if (!proxy) return;

  const sessionId = randomUUID();
  const previous = getGlobalDispatcher();
  // One agent per test, so each tunnel carries the session of its test.
  // Local fixture servers, such as the blob server, are not outside
  // traffic, so their requests do not go through the proxy.
  const agent = new EnvHttpProxyAgent({
    httpProxy: proxy.url,
    httpsProxy: proxy.url,
    noProxy: "localhost,127.0.0.1,::1",
    token: `Basic ${Buffer.from(`${sessionId}:${proxy.secret}`).toString("base64")}`,
    requestTls: { ca: proxy.caCert },
  });
  setGlobalDispatcher(agent);
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
