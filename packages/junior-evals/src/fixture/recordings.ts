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
import type { RecordingCounts } from "../recording-proxy/recording-proxy";

export interface Recordings {
  /** Replayed and live requests of the test, by rule. */
  counts(): Promise<RecordingCounts>;
}

/** Send the HTTP traffic of the current test through the recording proxy. */
export function installRecordings(): Recordings {
  const proxy = inject("recordingProxy");
  if (!proxy) return { counts: async () => ({}) };

  const sessionId = randomUUID();
  // The control API is on the proxy itself, so it must not use the proxy.
  const control = new Agent();
  const session = `${proxy.url}/__recording-proxy/sessions/${sessionId}`;
  const call = async (method: "GET" | "POST", url: string) => {
    const response = await request(url, {
      dispatcher: control,
      headers: { authorization: `Bearer ${proxy.secret}` },
      method,
    });
    if (response.statusCode >= 400) {
      await response.body.dump();
      throw new Error(
        `Recording proxy ${method} ${url} failed with HTTP ${response.statusCode}`,
      );
    }
    return response.body;
  };

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
    try {
      const action = task.result?.state === "pass" ? "commit" : "discard";
      await (await call("POST", `${session}/${action}`)).dump();
    } finally {
      await restoreTimeouts();
      setGlobalDispatcher(previous);
      await agent.close();
      await control.close();
    }
  });

  return {
    counts: async () =>
      (await (await call("GET", session)).json()) as RecordingCounts,
  };
}
