import { streamSimple } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { resolveGatewayModel } from "@/chat/pi/client";
import { modelClient } from "@/core/model/client";

describe("model client", () => {
  it("returns an aborted reply instead of throwing when its signal aborts", async () => {
    const client = modelClient({
      apiKey: async () => "test-key",
      resolveModel: resolveGatewayModel,
      send: streamSimple,
    });
    const controller = new AbortController();
    controller.abort();

    const reply = await client.complete(
      {
        model: {
          id: "anthropic/claude-opus-5.5",
          reasoning: "low",
          privacy: "private",
        },
        session: "conversation-1",
        context: { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      },
      controller.signal,
    );

    expect(reply.stopReason).toBe("aborted");
  });
});
