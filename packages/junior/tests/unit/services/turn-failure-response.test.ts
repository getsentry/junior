import { describe, expect, it, vi } from "vitest";
import { getInterruptionMarker } from "@/chat/interruption-marker";
import { finalizeFailedTurnReply } from "@/chat/services/turn-failure-response";
import type { AssistantReply } from "@/chat/services/turn-result";

function providerErrorReply(args: {
  assistantMessageCount: number;
  errorMessage?: string;
  text: string;
}): AssistantReply {
  return {
    text: args.text,
    diagnostics: {
      outcome: "provider_error",
      modelId: "test-model",
      assistantMessageCount: args.assistantMessageCount,
      toolCalls: [],
      toolResultCount: 0,
      toolErrorCount: 0,
      usedPrimaryText: false,
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    },
  };
}

describe("finalizeFailedTurnReply", () => {
  it("never delivers synthesized error text without assistant messages", () => {
    const logException = vi.fn().mockReturnValue("evt_123");

    const finalized = finalizeFailedTurnReply({
      reply: providerErrorReply({
        assistantMessageCount: 0,
        errorMessage: "ECONNRESET at redis.js:42",
        text: "Error: ECONNRESET at redis.js:42",
      }),
      logException,
      context: {},
    });

    expect(finalized.text).not.toContain("ECONNRESET");
    expect(finalized.text).toContain("event_id=evt_123");
  });

  it("delivers genuine model-authored partial text with the interruption marker", () => {
    const logException = vi.fn().mockReturnValue("evt_456");

    const finalized = finalizeFailedTurnReply({
      reply: providerErrorReply({
        assistantMessageCount: 1,
        text: "Here is what I found so far",
      }),
      logException,
      context: {},
    });

    expect(finalized.text).toBe(
      `Here is what I found so far${getInterruptionMarker()}`,
    );
  });
});
