import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDeliveredTurnStatePatch } from "@/chat/runtime/delivered-turn-state";
import { coerceThreadArtifactsState } from "@/chat/state/artifacts";
import { coerceThreadConversationState } from "@/chat/state/conversation";

describe("delivered turn state", () => {
  afterEach(() => vi.useRealTimers());

  it("reuses the logical turn assistant id across persistence retries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const first = buildDeliveredTurnStatePatch({
      artifacts: coerceThreadArtifactsState({}),
      conversation: coerceThreadConversationState({}),
      reply: {
        text: "delivered reply",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test/model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
      sessionId: "turn_msg-1",
    });

    vi.setSystemTime(2_000);
    const retried = buildDeliveredTurnStatePatch({
      artifacts: coerceThreadArtifactsState({}),
      conversation: first.conversation,
      reply: {
        text: "delivered reply",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test/model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
      sessionId: "turn_msg-1",
    });

    expect(
      retried.conversation.messages.filter(
        (message) => message.role === "assistant",
      ),
    ).toEqual([
      expect.objectContaining({
        id: "assistant:turn_msg-1",
        text: "delivered reply",
      }),
    ]);
  });

  it("does not invent an assistant message for intentional silence", () => {
    const state = buildDeliveredTurnStatePatch({
      artifacts: coerceThreadArtifactsState({}),
      conversation: coerceThreadConversationState({}),
      reply: {
        text: "",
        deliveryPlan: { mode: "thread", postThreadText: false },
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test/model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
      sessionId: "turn_silent",
    });

    expect(state.conversation.messages).toEqual([]);
  });
});
