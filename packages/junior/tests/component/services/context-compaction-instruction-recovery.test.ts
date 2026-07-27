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

describe("active context compaction instruction recovery", () => {
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

  it("recovers the current instruction and its actor without pending messages", async () => {
    const { compactActiveContextIfNeeded } =
      await import("@/chat/services/context-compaction");
    const { commitMessages, loadConversationProjection } =
      await import("@/chat/conversations/projection");
    const conversationId = "active-compaction-instruction-recovery";
    const instruction = user("Make the requested edit.", 1);
    await commitMessages({
      conversationId,
      messages: [instruction],
      newMessageProvenance: {
        authority: "instruction",
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
          userName: "alice",
          fullName: "Alice Example",
        },
      },
    });

    const result = await compactActiveContextIfNeeded(
      {
        conversationId,
        modelId: "openai/gpt-5.4",
        modelProfile: "standard",
        piMessages: [
          instruction,
          {
            role: "toolResult",
            toolCallId: "edit-1",
            toolName: "editFile",
            content: [{ type: "text", text: "x".repeat(1_600_000) }],
            isError: false,
            timestamp: 2,
          } as PiMessage,
        ],
      },
      {
        completeText: async () => ({ text: "No outstanding asks." }) as never,
      },
    );

    expect(result.compacted).toBe(true);
    expect(result.piMessages).toHaveLength(2);
    expect(textOf(result.piMessages![0]!)).toContain("No outstanding asks.");
    expect(textOf(result.piMessages![0]!)).not.toContain(
      "<current-instruction>",
    );
    expect(textOf(result.piMessages![1]!)).toBe(
      '<current-instruction author_id="U123" author_name="Alice Example">\nMake the requested edit.\n</current-instruction>',
    );

    const projection = await loadConversationProjection({ conversationId });
    expect(textOf(projection.messages[1]!)).toBe(
      '<current-instruction author_id="U123" author_name="Alice Example">\nMake the requested edit.\n</current-instruction>',
    );
    expect(projection.provenance[1]).toMatchObject({
      authority: "instruction",
      actor: {
        platform: "slack",
        teamId: "T123",
        userId: "U123",
        userName: "alice",
        fullName: "Alice Example",
      },
    });
  });
});
