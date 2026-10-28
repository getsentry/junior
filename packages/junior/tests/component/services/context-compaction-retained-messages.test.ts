import { describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
const ORIGINAL_ENV = { ...process.env };

function user(text: string, timestamp = 1): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistant(text: string, timestamp = 1): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {},
    stopReason: "stop",
    timestamp,
  } as PiMessage;
}

function textOf(message: PiMessage): string {
  return (
    (message as { content?: Array<{ text?: string }> }).content
      ?.map((part) => part.text ?? "")
      .join("\n") ?? ""
  );
}

describe("context compaction retained messages", () => {
  it("derives automatic trigger size from the model context window", async () => {
    const {
      calculateContextCompactionTargetTokens,
      calculateContextCompactionTriggerTokens,
      calculateContextInputLimitTokens,
    } = await import("@/chat/services/context-budget");

    const miniTrigger = calculateContextCompactionTriggerTokens({
      contextWindow: 400_000,
    });
    expect(miniTrigger).toBe(360_000);
    expect(calculateContextInputLimitTokens({ contextWindow: 400_000 })).toBe(
      380_000,
    );
    expect(calculateContextCompactionTargetTokens(miniTrigger)).toBe(288_000);
    expect(
      calculateContextCompactionTriggerTokens({
        contextWindow: 1_050_000,
      }),
    ).toBe(945_000);
  });

  it("uses configured model context windows for runtime thresholds", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_MODEL: "openai/gpt-5.4",
      AI_FAST_MODEL: "openai/gpt-5.4-mini",
      AI_MODEL_CONTEXT_WINDOW_TOKENS: "200000",
    };
    vi.resetModules();
    try {
      const {
        calculateContextCompactionTriggerTokens,
        getAgentContextCompactionTriggerTokens,
        getConversationContextCompactionTriggerTokens,
        getModelContextBudget,
      } = await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");

      expect(getAgentContextCompactionTriggerTokens("openai/gpt-5.4")).toBe(
        180_000,
      );
      expect(getModelContextBudget("openai/gpt-5.4")).toMatchObject({
        contextWindow: 200_000,
      });
      expect(getConversationContextCompactionTriggerTokens()).toBe(
        calculateContextCompactionTriggerTokens({
          ...resolveGatewayModel("openai/gpt-5.4-mini"),
          contextWindow: 200_000,
        }),
      );
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it("never raises an active model's advertised context window", async () => {
    process.env = {
      ...ORIGINAL_ENV,
      AI_MODEL_CONTEXT_WINDOW_TOKENS: "900000",
    };
    vi.resetModules();
    try {
      const { getModelContextBudget } =
        await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");
      const model = resolveGatewayModel("anthropic/claude-haiku-4.5");

      expect(getModelContextBudget(model.id).contextWindow).toBe(
        model.contextWindow,
      );
    } finally {
      process.env = { ...ORIGINAL_ENV };
      vi.resetModules();
    }
  });

  it("keeps newest eligible user messages in chronological order", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages(
      [
        user("older message that should not fit", 1),
        user("middle", 2),
        assistant("assistant reply", 3),
        user("<data_base64>raw-payload</data_base64>", 4),
        user("recent", 5),
      ],
      4,
    );

    expect(retained.map(textOf)).toEqual(["middle", "recent"]);
  });

  it("strips stale runtime context before retaining user text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nstale\n</runtime-turn-context>",
          },
          { type: "text", text: "actual user request" },
        ],
        timestamp: 1,
      } as PiMessage,
    ]);

    expect(retained.map(textOf)).toEqual(["actual user request"]);
  });

  it("unwraps current instruction markers before retaining user text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      user(
        "<current-instruction>\nuse &lt;tag&gt; literally\n</current-instruction>",
      ),
    ]);

    expect(retained.map(textOf)).toEqual(["use <tag> literally"]);
  });

  it("unwraps current instruction markers from composite prompt text", async () => {
    const { selectRetainedUserMessages } =
      await import("@/chat/services/context-compaction");

    const retained = selectRetainedUserMessages([
      user(
        [
          "<thread-background>",
          "prior context",
          "</thread-background>",
          "",
          "<current-instruction>",
          "actual follow-up",
          "</current-instruction>",
        ].join("\n"),
      ),
    ]);

    expect(retained.map(textOf)).toEqual(["actual follow-up"]);
  });
});
