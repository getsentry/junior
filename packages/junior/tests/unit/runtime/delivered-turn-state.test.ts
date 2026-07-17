import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDeliveredTurnStatePatch,
  buildRecoveredDeliveredTurnStatePatch,
} from "@/chat/runtime/delivered-turn-state";
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

  it("repairs derived conversation state from a canonical terminal", () => {
    const conversation = coerceThreadConversationState({
      conversation: {
        processing: {
          activeTurnId: "turn-1",
          pendingAuth: {
            kind: "plugin",
            provider: "github",
            actorId: "U123",
            sessionId: "turn-1",
            linkSentAtMs: 1,
          },
        },
      },
    });
    conversation.messages.push({
      id: "message-1",
      role: "user",
      text: "continue",
      createdAtMs: 1,
    });

    const repaired = buildRecoveredDeliveredTurnStatePatch({
      conversation,
      sessionId: "turn-1",
      userMessageId: "message-1",
    });

    expect(repaired.conversation.processing).toMatchObject({
      activeTurnId: undefined,
      pendingAuth: undefined,
    });
    expect(repaired.conversation.messages[0]?.meta?.replied).toBe(true);
  });
});
