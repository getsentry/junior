import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";

const ORIGINAL_ENV = { ...process.env };
const OVERSIZED_CONTEXT_TEXT = "x".repeat(1_600_000);

function user(text: string, timestamp = 1): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as PiMessage;
}

function assistantWithUsage(
  text: string,
  {
    totalTokens,
    outputTokens = 0,
    timestamp = 1,
  }: {
    totalTokens: number;
    outputTokens?: number;
    timestamp?: number;
  },
): PiMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: totalTokens - outputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
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

describe("active-turn context compaction", () => {
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

  it("includes provider output in measured context usage", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const completeText = vi.fn(
      async () => ({ text: "Continue from the summary." }) as never,
    );

    const result = await compactActiveContextIfNeeded(
      {
        conversationId: "conversation-provider-usage",
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        piMessages: [
          user("Continue the task.", 1),
          assistantWithUsage("Work completed so far.", {
            totalTokens: 360_001,
            outputTokens: 160_001,
            timestamp: 2,
          }),
        ],
      },
      { completeText },
    );

    expect(result.compacted).toBe(true);
    expect(completeText).toHaveBeenCalledOnce();
  });

  it("ignores trailing tool details outside model input", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const completeText = vi.fn();

    const result = await compactActiveContextIfNeeded(
      {
        conversationId: "conversation-tool-details",
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        piMessages: [
          user("Inspect the tool result.", 1),
          assistantWithUsage("Reading the requested file.", {
            totalTokens: 20_000,
            timestamp: 2,
          }),
          {
            role: "toolResult",
            toolCallId: "read-1",
            toolName: "readFile",
            content: [{ type: "text", text: "Visible result." }],
            details: { internalPayload: OVERSIZED_CONTEXT_TEXT },
            isError: false,
            timestamp: 3,
          } as PiMessage,
        ],
      },
      { completeText },
    );

    expect(result).toEqual({ compacted: false, reason: "below_threshold" });
    expect(completeText).not.toHaveBeenCalled();
  });

  it("replaces oversized tool history with continuation state", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection, loadProjection } =
      await import("@/chat/conversations/projection");
    const { getConversationEventStore } = await import("@/chat/db");
    const conversationId = "conversation-active-capacity";
    await commitMessages({
      conversationId,
      messages: [user("Make the requested edit.", 1)],
    });
    const activeMessages = [
      user(
        "<runtime-turn-context>\nFresh runtime context\n</runtime-turn-context>",
        2,
      ),
      user("Make the requested edit.", 3),
      assistantWithUsage("I will apply the edit.", {
        totalTokens: 20_000,
        timestamp: 4,
      }),
      {
        role: "toolResult",
        toolCallId: "edit-1",
        toolName: "editFile",
        content: [{ type: "text", text: OVERSIZED_CONTEXT_TEXT }],
        isError: false,
        timestamp: 5,
      } as PiMessage,
    ];
    const result = await compactActiveContextIfNeeded(
      {
        conversationId,
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        pendingMessages: [
          {
            message: user(
              "<current-instruction>\nAlso run the focused test.\n</current-instruction>",
              6,
            ),
            provenance: {
              authority: "instruction",
              actor: {
                platform: "slack",
                teamId: "T123",
                userId: "U_STEER",
                userName: "steering-user",
              },
            },
          },
        ],
        piMessages: activeMessages,
      },
      {
        completeText: async () => ({ text: "No outstanding asks." }) as never,
      },
    );

    expect(result.compacted).toBe(true);
    expect(result.piMessages).toHaveLength(3);
    expect(textOf(result.piMessages![0]!)).toContain(
      "<runtime-turn-context>\nFresh runtime context\n</runtime-turn-context>",
    );
    expect(textOf(result.piMessages![0]!)).not.toContain(
      "<current-instruction>",
    );
    expect(textOf(result.piMessages![1]!)).toBe(
      "<current-instruction>\nAlso run the focused test.\n</current-instruction>",
    );
    expect(textOf(result.piMessages![2]!)).toContain("No outstanding asks.");
    expect(textOf(result.piMessages![2]!)).not.toContain(
      "<runtime-turn-context>",
    );
    expect(textOf(result.piMessages![2]!)).not.toContain(
      "<current-instruction>",
    );
    const durable = await loadProjection({ conversationId });
    expect(durable).toHaveLength(2);
    expect(textOf(durable[0]!)).toBe(
      "<current-instruction>\nAlso run the focused test.\n</current-instruction>",
    );
    expect(textOf(durable[1]!)).toContain("No outstanding asks.");
    expect(textOf(durable[1]!)).not.toContain("<runtime-turn-context>");
    expect(textOf(durable[1]!)).not.toContain("<current-instruction>");
    const projection = await loadConversationProjection({ conversationId });
    expect(projection.modelProfile).toBe("standard");
    expect(projection.provenance[0]).toMatchObject({
      authority: "instruction",
      actor: { userId: "U_STEER" },
    });
    expect(projection.provenance[1]).toEqual({ authority: "context" });
    const compactionEvent = (
      await getConversationEventStore().loadHistory(conversationId)
    ).find((event) => event.data.type === "compaction");
    expect(compactionEvent?.data).toMatchObject({
      type: "compaction",
      modelProfile: "standard",
      modelId: "openai/gpt-5.4",
      summary: "No outstanding asks.",
      details: {
        reason: "capacity",
        triggerTokens: 360_000,
        inputLimitTokens: 380_000,
        inputMessageCount: 5,
        retainedMessageCount: 1,
        summaryChars: 20,
      },
    });
    expect(
      compactionEvent?.data.type === "compaction"
        ? compactionEvent.data.details?.estimatedInputTokens
        : undefined,
    ).toBeGreaterThan(360_000);
    expect(
      compactionEvent?.data.type === "compaction"
        ? compactionEvent.data.details?.replacementInputTokens
        : undefined,
    ).toBeLessThan(380_000);
  });
});
