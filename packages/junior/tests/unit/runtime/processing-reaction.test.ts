import { beforeEach, describe, expect, it, vi } from "vitest";

const { addReactionToMessage, removeReactionFromMessage } = vi.hoisted(() => ({
  addReactionToMessage:
    vi.fn<typeof import("@/chat/slack/outbound").addReactionToMessage>(),
  removeReactionFromMessage:
    vi.fn<typeof import("@/chat/slack/outbound").removeReactionFromMessage>(),
}));

vi.mock("@/chat/slack/outbound", () => ({
  addReactionToMessage,
  removeReactionFromMessage,
}));

vi.mock("@/chat/config", () => ({
  getChatConfig: () => ({
    slack: {
      processingReactionEmoji: "eyes",
      completedReactionEmoji: "white_check_mark",
    },
  }),
}));

import { startSlackProcessingReactionForMessage } from "@/chat/runtime/processing-reaction";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";

function slackTs(value: string) {
  const ts = parseSlackMessageTs(value);
  if (!ts) {
    throw new Error(`Invalid test Slack message timestamp: ${value}`);
  }
  return ts;
}

describe("processing reaction session", () => {
  beforeEach(() => {
    addReactionToMessage.mockReset();
    removeReactionFromMessage.mockReset();
    addReactionToMessage.mockResolvedValue({ ok: true });
    removeReactionFromMessage.mockResolvedValue({ ok: true });
  });

  it("removes the processing reaction and adds done on complete", async () => {
    const session = await startSlackProcessingReactionForMessage({
      channelId: "C0PROCESSING",
      timestamp: slackTs("1700007301.000000"),
      logException: () => undefined,
      logContext: {},
    });

    await session.complete();

    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C0PROCESSING",
        emoji: "eyes",
      }),
    );
    expect(removeReactionFromMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C0PROCESSING",
        emoji: "eyes",
      }),
    );
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C0PROCESSING",
        emoji: "white_check_mark",
      }),
    );
  });

  it("still adds done when removing the processing reaction fails", async () => {
    removeReactionFromMessage.mockRejectedValueOnce(
      new Error("no_reaction found"),
    );

    const session = await startSlackProcessingReactionForMessage({
      channelId: "C0PROCESSING",
      timestamp: slackTs("1700007302.000000"),
      logException: () => undefined,
      logContext: {},
    });

    await session.complete();

    expect(removeReactionFromMessage).toHaveBeenCalledTimes(1);
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "white_check_mark",
      }),
    );
  });

  it("keeps the processing reaction when keep() is called", async () => {
    const session = await startSlackProcessingReactionForMessage({
      channelId: "C0PROCESSING",
      timestamp: slackTs("1700007303.000000"),
      logException: () => undefined,
      logContext: {},
    });

    session.keep();
    await session.complete();

    expect(removeReactionFromMessage).not.toHaveBeenCalled();
    expect(addReactionToMessage).toHaveBeenCalledTimes(1);
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "eyes",
      }),
    );
  });
});
