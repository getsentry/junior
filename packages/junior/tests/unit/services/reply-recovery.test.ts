import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { nextReplyRecovery } from "@/chat/services/reply-recovery";

function user(text: string): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1,
  } as PiMessage;
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

describe("reply recovery", () => {
  it("preserves an earlier delivered reply across later user input", () => {
    const summary = user(`${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue.`);
    const delivered = assistant("Progress already delivered.");
    const steering = user("Also check the session log.");
    const rejected = assistant(
      JSON.stringify({ type: "tool_call", name: "bash", input: {} }),
    );

    expect(
      nextReplyRecovery({
        attempt: 0,
        lastAssistant: rejected,
        messages: [summary, delivered, steering, rejected],
      }),
    ).toEqual({
      kind: "retry",
      messages: [summary, delivered, steering],
      reason: "raw_tool_payload",
    });
  });

  it("exhausts recovery after one rejected continuation", () => {
    const summary = user(`${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue.`);
    const rejected = assistant("");

    expect(
      nextReplyRecovery({
        attempt: 1,
        lastAssistant: rejected,
        messages: [summary, rejected],
      }),
    ).toEqual({ kind: "exhausted", reason: "empty" });
  });
});
