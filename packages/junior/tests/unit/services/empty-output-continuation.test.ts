import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiMessage } from "@/chat/pi/messages";
import { ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import { nextEmptyOutputContinuation } from "@/chat/services/empty-output-continuation";

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

describe("empty output continuation", () => {
  it("preserves an earlier delivered reply across later user input", () => {
    const summary = user(`${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue.`);
    const delivered = assistant("Progress already delivered.");
    const steering = user("Also check the session log.");
    const empty = assistant("");

    expect(
      nextEmptyOutputContinuation({
        attempt: 0,
        lastAssistant: empty,
        messages: [summary, delivered, steering, empty],
      }),
    ).toEqual({
      kind: "retry",
      messages: [summary, delivered, steering],
    });
  });

  it("stops after one empty continuation", () => {
    const summary = user(`${ACTIVE_TURN_COMPACTION_SUMMARY_PREFIX}\nContinue.`);
    const emptyOutput = assistant("");

    expect(
      nextEmptyOutputContinuation({
        attempt: 1,
        lastAssistant: emptyOutput,
        messages: [summary, emptyOutput],
      }),
    ).toEqual({ kind: "exhausted" });
  });
});
