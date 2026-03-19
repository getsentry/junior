import { describe, expect, it, vi } from "vitest";
import { createSlackMessageAddReactionTool } from "@/chat/tools/slack-message-add-reaction";

const addReactionToMessage = vi.fn();

vi.mock("@/chat/slack-actions/channel", () => ({
  addReactionToMessage: (...args: unknown[]) => addReactionToMessage(...args),
}));

function createState() {
  const cache = new Map<string, unknown>();
  return {
    getOperationResult: <T>(key: string): T | undefined =>
      cache.get(key) as T | undefined,
    setOperationResult: (key: string, value: unknown): void => {
      cache.set(key, value);
    },
  };
}

describe("slackMessageAddReaction tool", () => {
  it("rejects non-alias emoji input", async () => {
    addReactionToMessage.mockReset();
    const tool = createSlackMessageAddReactionTool(
      {
        channelId: "C123",
        messageTs: "1700000000.100",
        sandbox: {} as any,
      },
      createState() as any,
    );
    if (!tool.execute) {
      throw new Error("Expected executable tool");
    }

    const result = await tool.execute({ emoji: "✅" }, {} as any);
    expect(result).toEqual(
      expect.objectContaining({
        ok: false,
      }),
    );
    expect(addReactionToMessage).not.toHaveBeenCalled();
  });

  it("normalizes valid alias emoji names", async () => {
    addReactionToMessage.mockReset();
    addReactionToMessage.mockResolvedValue({ ok: true });
    const tool = createSlackMessageAddReactionTool(
      {
        channelId: "C123",
        messageTs: "1700000000.100",
        sandbox: {} as any,
      },
      createState() as any,
    );
    if (!tool.execute) {
      throw new Error("Expected executable tool");
    }

    const result = await tool.execute({ emoji: ":Thumbs_Up:" }, {} as any);
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        emoji: "thumbs_up",
      }),
    );
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "thumbs_up",
      }),
    );
  });

  it("preserves documented Slack skin-tone modifiers", async () => {
    addReactionToMessage.mockReset();
    addReactionToMessage.mockResolvedValue({ ok: true });
    const tool = createSlackMessageAddReactionTool(
      {
        channelId: "C123",
        messageTs: "1700000000.100",
        sandbox: {} as any,
      },
      createState() as any,
    );
    if (!tool.execute) {
      throw new Error("Expected executable tool");
    }

    const result = await tool.execute(
      { emoji: ":thumbsup::skin-tone-6:" },
      {} as any,
    );
    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        emoji: "thumbsup::skin-tone-6",
      }),
    );
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "thumbsup::skin-tone-6",
      }),
    );
  });
});
