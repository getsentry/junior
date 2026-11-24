import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Sentry from "@/chat/sentry";
import { subscribeGatewayRequestTiming } from "@/chat/pi/gateway-request-timing";
import { withChatSpanAttributes } from "@/chat/pi/chat-span";

const VERCEL_ID = "iad1::iad1::abcde-1-test";
const RESPONSE_ID = "gen_01TESTRESPONSEID";
const BODY = JSON.stringify({ model: "test", messages: [] });

function finalMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "hi" }],
    api: "anthropic-messages",
    provider: "vercel-ai-gateway",
    model: "anthropic/claude-test",
    responseId: RESPONSE_ID,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("gateway request timing", () => {
  const spans: ReturnType<typeof Sentry.spanToJSON>["attributes"][] = [];
  let server: Server;
  let url: string;
  let unsubscribe: () => void;

  beforeAll(async () => {
    const client = Sentry.init({
      dsn: "https://public@example.com/1",
      tracesSampleRate: 1,
      defaultIntegrations: false,
      // Production also records fetch spans from the same undici channels.
      integrations: [Sentry.nativeNodeFetchIntegration()],
      transport: () => ({
        send: async () => ({ statusCode: 200 }),
        flush: async () => true,
      }),
    });
    client?.on("spanEnd", (span) => {
      const { attributes } = Sentry.spanToJSON(span);
      if (attributes["sentry.op"] === "gen_ai.chat") {
        spans.push(attributes);
      }
    });
    unsubscribe = subscribeGatewayRequestTiming();
    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.setHeader("x-vercel-id", VERCEL_ID);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/messages`;
  });

  afterAll(async () => {
    unsubscribe();
    await new Promise((resolve) => server.close(resolve));
    await Sentry.getClient()?.close();
  });

  // Stands in for Pi: sends `attempts` requests, then reports the last
  // response headers like Pi does before it reads the stream.
  function gatewayStream(
    attempts: number,
  ): StreamFunction<"anthropic-messages", SimpleStreamOptions> {
    return (model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        let response: Response | undefined;
        for (let i = 0; i < attempts; i++) {
          response = await fetch(url, { method: "POST", body: BODY });
          await response.text();
        }
        await options?.onResponse?.(
          {
            status: response!.status,
            headers: Object.fromEntries(response!.headers),
          },
          model,
        );
        stream.end(finalMessage());
      })();
      return stream;
    };
  }

  // Stands in for the SDK's `piAiIntegration`: Pi calls the provider inside
  // a `gen_ai.chat` span, which ends when the returned stream settles.
  async function runChat(attempts: number) {
    const stream = Sentry.startSpanManual(
      {
        name: "chat anthropic/claude-test",
        op: "gen_ai.chat",
        attributes: {
          "sentry.origin": "auto.ai.pi_ai",
          // The test server is local, so the chat span names it as the
          // gateway.
          "server.address": "127.0.0.1",
        },
      },
      (span) => {
        const result = withChatSpanAttributes(gatewayStream(attempts))(
          { id: "anthropic/claude-test" } as Model<"anthropic-messages">,
          normalizeContext({
            messages: [{ role: "user", content: "hi", timestamp: 0 }],
          }),
          undefined,
        );
        void result.result().then(() => span.end());
        return result;
      },
    );
    await stream.result();
    await expect.poll(() => spans.length).toBeGreaterThan(0);
    return spans.pop()!;
  }

  it("records the request phases on the active gen_ai.chat span", async () => {
    const first = await runChat(1);
    expect(first).toMatchObject({
      "app.ai.http.attempt_count": 1,
      "app.ai.http.connection_reused": false,
      "app.ai.http.connect_ms": expect.any(Number),
      "app.ai.http.queue_ms": expect.any(Number),
      "app.ai.http.body_send_ms": expect.any(Number),
      "app.ai.http.response_wait_ms": expect.any(Number),
      "http.request.body.size": Buffer.byteLength(BODY),
      "app.ai.event_loop.utilization": expect.any(Number),
      "app.ai.gateway.vercel_id": VERCEL_ID,
    });

    // A retry keeps only the last attempt, which reuses the open socket.
    const retried = await runChat(2);
    expect(retried["app.ai.http.attempt_count"]).toBe(2);
    expect(retried["app.ai.http.connection_reused"]).toBe(true);
    expect(retried["app.ai.http.connect_ms"]).toBeUndefined();
    expect(retried["app.ai.http.response_wait_ms"]).toEqual(expect.any(Number));
  });
});
