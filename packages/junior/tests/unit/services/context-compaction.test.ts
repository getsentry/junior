import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    timestamp,
  } as PiMessage;
}

function textOf(message: PiMessage): string {
  return (
    (message as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ""
  );
}

describe("context compaction retained messages", () => {
  it("derives automatic trigger size from the model context window", async () => {
    const {
      calculateContextCompactionTargetTokens,
      calculateContextCompactionTriggerTokens,
    } = await import("@/chat/services/context-budget");

    const miniTrigger = calculateContextCompactionTriggerTokens({
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(miniTrigger).toBe(225_000);
    expect(calculateContextCompactionTargetTokens(miniTrigger)).toBe(180_000);
    expect(
      calculateContextCompactionTriggerTokens({
        contextWindow: 1_050_000,
        maxTokens: 128_000,
      }),
    ).toBe(691_500);
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
      } = await import("@/chat/services/context-budget");
      const { resolveGatewayModel } = await import("@/chat/pi/client");

      expect(getAgentContextCompactionTriggerTokens()).toBe(112_500);
      expect(getConversationContextCompactionTriggerTokens()).toBe(
        calculateContextCompactionTriggerTokens(
          resolveGatewayModel("openai/gpt-5.4-mini"),
        ),
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
});

describe("context compaction checkpoint fork", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("automatic compaction creates a new checkpoint without rewriting the previous one", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { getAgentTurnSessionCheckpoint, upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");

    const priorMessages = [
      user("Please remember the deploy blocker.", 1),
      assistant("The blocker is missing migration approval.", 2),
    ];
    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-1",
      sessionId: "turn-1",
      sliceId: 1,
      state: "completed",
      piMessages: priorMessages,
    });
    const conversation = coerceThreadConversationState({});
    conversation.processing.lastSessionId = "turn-1";

    const compactor = createContextCompactor({
      completeText: async () =>
        ({
          text: "Outstanding ask: continue tracking migration approval.",
        }) as never,
      autoCompactionTriggerTokens: 0,
    });

    const result = await compactor.maybeCompact({
      conversation,
      conversationId: "conversation-1",
      previousSessionId: "turn-1",
    });

    expect(result.compacted).toBe(true);
    expect(result.sessionId).toBe("compaction_turn-1");
    expect(conversation.processing.lastSessionId).toBe(result.sessionId);

    await expect(
      getAgentTurnSessionCheckpoint("conversation-1", "turn-1"),
    ).resolves.toMatchObject({
      state: "completed",
      piMessages: priorMessages,
    });

    const fork = await getAgentTurnSessionCheckpoint(
      "conversation-1",
      result.sessionId!,
    );
    expect(fork).toMatchObject({ state: "completed" });
    expect(fork?.piMessages.map(textOf).join("\n")).toContain(
      "Context handoff summary",
    );
    expect(fork?.piMessages.map(textOf).join("\n")).toContain(
      "migration approval",
    );
  });

  it("summarizes recent history when compaction input is oversized", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");

    const priorMessages = [
      ...Array.from({ length: 35 }, (_, index) =>
        user(`old-${index.toString().padStart(2, "0")} ${"x".repeat(5_000)}`),
      ),
      user("recent-critical-marker keep the rollback plan"),
    ];
    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-large",
      sessionId: "turn-large",
      sliceId: 1,
      state: "completed",
      piMessages: priorMessages,
    });
    const conversation = coerceThreadConversationState({});
    conversation.processing.lastSessionId = "turn-large";
    let capturedPrompt = "";
    let capturedMessageAttributeMode: unknown;
    const compactor = createContextCompactor({
      completeText: async (params) => {
        capturedPrompt = String(params.messages[0]?.content ?? "");
        capturedMessageAttributeMode = params.messageAttributeMode;
        return { text: "Summary keeps the rollback plan." } as never;
      },
      autoCompactionTriggerTokens: 0,
    });

    await compactor.maybeCompact({
      conversation,
      conversationId: "conversation-large",
      previousSessionId: "turn-large",
    });

    expect(capturedMessageAttributeMode).toBe("metadata");
    expect(capturedPrompt).toContain("[older context omitted]");
    expect(capturedPrompt).not.toContain("old-00");
    expect(capturedPrompt).toContain("recent-critical-marker");
  });

  it("counts structured tool context when deciding whether to compact", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");

    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-tool-context",
      sessionId: "turn-tool-context",
      sliceId: 1,
      state: "completed",
      piMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-call-1",
              name: "readFile",
              arguments: { path: "src/large-file.ts", limit: 10_000 },
            },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "test-model",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "toolUse",
          timestamp: 1,
        },
      ] as PiMessage[],
    });
    const conversation = coerceThreadConversationState({});
    conversation.processing.lastSessionId = "turn-tool-context";
    let summarized = false;
    const compactor = createContextCompactor({
      completeText: async () => {
        summarized = true;
        return { text: "Tool context was compacted." } as never;
      },
      autoCompactionTriggerTokens: 1,
    });

    const result = await compactor.maybeCompact({
      conversation,
      conversationId: "conversation-tool-context",
      previousSessionId: "turn-tool-context",
    });

    expect(result.compacted).toBe(true);
    expect(summarized).toBe(true);
  });

  it("does not compact checkpoints that are awaiting resume", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { upsertAgentTurnSessionCheckpoint } =
      await import("@/chat/state/turn-session-store");

    await upsertAgentTurnSessionCheckpoint({
      conversationId: "conversation-2",
      sessionId: "turn-awaiting",
      sliceId: 2,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: [user("continue me")],
    });
    const conversation = coerceThreadConversationState({});
    conversation.processing.lastSessionId = "turn-awaiting";
    const compactor = createContextCompactor({
      completeText: async () => ({ text: "should not run" }) as never,
    });

    await expect(
      compactor.maybeCompact({
        conversation,
        conversationId: "conversation-2",
        previousSessionId: "turn-awaiting",
      }),
    ).resolves.toEqual({ compacted: false, reason: "not_completed" });
    expect(conversation.processing.lastSessionId).toBe("turn-awaiting");
  });

  it("does not compact when the checkpoint is missing", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");

    const completeText = vi.fn(async () => ({ text: "should not run" }));
    const conversation = coerceThreadConversationState({});
    conversation.processing.lastSessionId = "turn-missing";
    const compactor = createContextCompactor({
      completeText: completeText as never,
    });

    await expect(
      compactor.maybeCompact({
        conversation,
        conversationId: "conversation-missing",
        previousSessionId: "turn-missing",
      }),
    ).resolves.toEqual({ compacted: false, reason: "missing_context" });
    expect(completeText).not.toHaveBeenCalled();
    expect(conversation.processing.lastSessionId).toBe("turn-missing");
  });
});
