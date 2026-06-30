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

describe("context compaction projection reset", () => {
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

  it("automatic compaction replaces the conversation projection without a synthetic session", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages, loadProjection, loadProjectionWithRequester } =
      await import("@/chat/state/session-log");

    const priorMessages = [
      user("Please remember the deploy blocker.", 1),
      assistant("The blocker is missing migration approval.", 2),
    ];
    await commitMessages({
      conversationId: "conversation-1",
      messages: priorMessages,
      ttlMs: 60_000,
      requester: {
        slackUserId: "U123",
        slackUserName: "alice",
        fullName: "Alice Example",
        email: "alice@sentry.io",
      },
    });
    const conversation = coerceThreadConversationState({});

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
      piMessages: priorMessages,
    });

    expect(result.compacted).toBe(true);
    expect(result).not.toHaveProperty("sessionId");
    const compactedMessages = result.piMessages ?? [];
    expect(compactedMessages.map(textOf).join("\n")).toContain(
      "Context handoff summary",
    );
    expect(compactedMessages.map(textOf).join("\n")).toContain(
      "migration approval",
    );
    await expect(
      loadProjection({ conversationId: "conversation-1" }),
    ).resolves.toEqual(compactedMessages);
    await expect(
      loadProjectionWithRequester({ conversationId: "conversation-1" }),
    ).resolves.toMatchObject({
      messages: compactedMessages,
      requester: {
        slackUserId: "U123",
        slackUserName: "alice",
        fullName: "Alice Example",
        email: "alice@sentry.io",
      },
    });
  });

  it("summarizes recent history when compaction input is oversized", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages } = await import("@/chat/state/session-log");

    const priorMessages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<runtime-turn-context>\nbootstrap instructions that must not be summarized\n</runtime-turn-context>",
          },
          { type: "text", text: "first actual request" },
        ],
        timestamp: 1,
      } as PiMessage,
      ...Array.from({ length: 35 }, (_, index) =>
        user(`old-${index.toString().padStart(2, "0")} ${"x".repeat(5_000)}`),
      ),
      user("recent-critical-marker keep the rollback plan"),
    ];
    await commitMessages({
      conversationId: "conversation-large",
      messages: priorMessages,
      ttlMs: 60_000,
    });
    const conversation = coerceThreadConversationState({});
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
      piMessages: priorMessages,
    });

    expect(capturedMessageAttributeMode).toBe("metadata");
    expect(capturedPrompt).toContain("[older context omitted]");
    expect(capturedPrompt).not.toContain("old-00");
    expect(capturedPrompt).not.toContain("bootstrap instructions");
    expect(capturedPrompt).not.toContain("<runtime-turn-context>");
    expect(capturedPrompt).toContain("recent-critical-marker");
  });

  it("counts structured tool context when deciding whether to compact", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");
    const { commitMessages } = await import("@/chat/state/session-log");

    const priorMessages = [
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
    ] as PiMessage[];
    await commitMessages({
      conversationId: "conversation-tool-context",
      messages: priorMessages,
      ttlMs: 60_000,
    });
    const conversation = coerceThreadConversationState({});
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
      piMessages: priorMessages,
    });

    expect(result.compacted).toBe(true);
    expect(summarized).toBe(true);
  });

  it("does not compact when there is no reusable conversation projection", async () => {
    const { createContextCompactor } =
      await import("@/chat/services/context-compaction");
    const { coerceThreadConversationState } =
      await import("@/chat/state/conversation");

    const completeText = vi.fn(async () => ({ text: "should not run" }));
    const conversation = coerceThreadConversationState({});
    const compactor = createContextCompactor({
      completeText: completeText as never,
    });

    await expect(
      compactor.maybeCompact({
        conversation,
        conversationId: "conversation-missing",
        piMessages: [],
      }),
    ).resolves.toEqual({ compacted: false, reason: "missing_context" });
    expect(completeText).not.toHaveBeenCalled();
  });
});
