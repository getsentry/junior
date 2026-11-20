import { describe, expect, it } from "vitest";
import { createGatewayComplete } from "@/core/model/complete";

describe("createGatewayComplete", () => {
  it("returns an aborted reply instead of throwing when its signal aborts", async () => {
    const complete = createGatewayComplete({
      modelId: "anthropic/claude-opus-5.5",
      reasoningLevel: "low",
      conversationId: "conversation-1",
    });
    const controller = new AbortController();
    controller.abort();

    const reply = await complete(
      { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
      controller.signal,
    );

    expect(reply.stopReason).toBe("aborted");
  });
});
