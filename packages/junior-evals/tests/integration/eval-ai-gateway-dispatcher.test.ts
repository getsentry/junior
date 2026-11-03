import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { streamAnthropic, type Message as PiAiMessage } from "@/chat/pi/sdk";
import { resolveGatewayModel } from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { nextProviderRetry } from "@/chat/services/provider-retry";
import { installEvalAiGatewayDispatcher } from "../../src/eval-ai-gateway-dispatcher";

const openServers = new Set<http.Server>();

async function startServer(listener: http.RequestListener): Promise<string> {
  const server = http.createServer(listener);
  openServers.add(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP test server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startStalledServer(sendHeaders = true): Promise<string> {
  return await startServer((_request, response) => {
    if (!sendHeaders) return;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
}

afterEach(async () => {
  for (const server of openServers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  openServers.clear();
});

describe("eval AI Gateway dispatcher", () => {
  it("drops the session affinity header", async () => {
    const targetOrigin = await startServer((request, response) => {
      response.end(JSON.stringify(request.headers));
    });
    const restore = installEvalAiGatewayDispatcher(1_000, targetOrigin);
    try {
      const response = await fetch(targetOrigin, {
        headers: {
          "X-Session-Affinity": "agent:212aaafaf81eee9e28b821a24fd743e7",
          "x-api-key": "kept",
        },
      });
      const headers = await response.json();

      expect(headers).not.toHaveProperty("x-session-affinity");
      expect(headers).toMatchObject({ "x-api-key": "kept" });
    } finally {
      await restore();
    }
  });

  it("terminates a request that never receives headers", async () => {
    const targetOrigin = await startStalledServer(false);
    const restore = installEvalAiGatewayDispatcher(100, targetOrigin);
    try {
      await expect(fetch(targetOrigin)).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "UND_ERR_HEADERS_TIMEOUT" }),
      });
    } finally {
      await restore();
    }
  });

  it("terminates a response body that stops producing data", async () => {
    const targetOrigin = await startStalledServer();
    const restore = installEvalAiGatewayDispatcher(100, targetOrigin);

    try {
      const response = await fetch(targetOrigin);
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Expected response body reader");

      await expect(reader.read()).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "UND_ERR_BODY_TIMEOUT" }),
      });
    } finally {
      await restore();
    }
  });

  it("turns a stalled Pi stream into resumable provider history", async () => {
    const targetOrigin = await startStalledServer();
    const restore = installEvalAiGatewayDispatcher(100, targetOrigin);
    const userMessage: PiAiMessage = {
      role: "user",
      content: [{ type: "text", text: "help" }],
      timestamp: Date.now(),
    };

    try {
      const stream = streamAnthropic(
        resolveGatewayModel("openai/gpt-5.6-sol"),
        { messages: [userMessage] },
        {
          client: {
            beta: {
              messages: {
                create: () => ({
                  asResponse: async () => await fetch(targetOrigin),
                }),
              },
            },
          } as never,
        },
      );
      const failedAssistant = await stream.result();

      expect(failedAssistant).toMatchObject({
        role: "assistant",
        stopReason: "error",
        errorMessage: "terminated",
      });
      expect(
        nextProviderRetry({
          attempt: 0,
          failure: failedAssistant,
          messages: [userMessage as PiMessage, failedAssistant as PiMessage],
        }),
      ).toMatchObject({ delayMs: 2_000, messages: [userMessage as PiMessage] });
    } finally {
      await restore();
    }
  });
});
