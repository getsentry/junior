import { describe, expect, it } from "vitest";
import { gatewayModelClient } from "@/chat/pi/model-client";

describe("model client", () => {
  it("returns an aborted reply instead of throwing when its signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const reply = await gatewayModelClient.complete(
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
