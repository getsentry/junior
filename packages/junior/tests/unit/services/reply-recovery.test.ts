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
  it("does not roll back across an earlier assistant reply", () => {
    const summary = user(`${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue.`);
    const delivered = assistant("Progress already delivered.");
    const rejected = assistant(
      JSON.stringify({ type: "tool_call", name: "bash", input: {} }),
    );

    expect(
      nextReplyRecovery({
        attempt: 0,
        lastAssistant: rejected,
        messages: [summary, delivered, rejected],
      }),
    ).toEqual({ kind: "exhausted", reason: "raw_tool_payload" });
  });
});
