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
      {
        role: "toolResult",
        toolCallId: "edit-1",
        toolName: "editFile",
        content: [{ type: "text", text: "x".repeat(1_600_000) }],
        isError: false,
        timestamp: 4,
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
              5,
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
        inputMessageCount: 4,
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
