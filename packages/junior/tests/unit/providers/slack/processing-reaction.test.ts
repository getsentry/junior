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

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  logException: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("@/chat/config", () => ({
  getChatConfig: () => ({
    slack: {
      processingReactionEmoji: "eyes",
      completedReactionEmoji: "white_check_mark",
    },
  }),
}));

import { logException, logWarn } from "@/chat/logging";
import { startProcessingReactionForMessage } from "@/chat/providers/slack/processing-reaction";
import { SlackActionError } from "@/chat/slack/client";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";

function slackTs(value: string) {
  const ts = parseSlackMessageTs(value);
  if (!ts) {
    throw new Error(`Invalid test Slack message timestamp: ${value}`);
  }
  return ts;
}

describe("Slack processing reaction", () => {
  beforeEach(() => {
    addReactionToMessage.mockReset();
    removeReactionFromMessage.mockReset();
    addReactionToMessage.mockResolvedValue({ ok: true });
    removeReactionFromMessage.mockResolvedValue({ ok: true });
    vi.mocked(logException).mockClear();
    vi.mocked(logWarn).mockClear();
  });

  it("removes the processing reaction and adds done on complete", async () => {
    const reaction = await startProcessingReactionForMessage({
      channelId: "C0PROCESSING",
      timestamp: slackTs("1700007301.000000"),
    });

    await reaction.complete();

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

    const reaction = await startProcessingReactionForMessage({
      channelId: "C0PROCESSING",
      timestamp: slackTs("1700007302.000000"),
    });

    await reaction.complete();

    expect(removeReactionFromMessage).toHaveBeenCalledTimes(1);
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "white_check_mark",
      }),
    );
  });

  it("keeps the processing reaction when keep() is called", async () => {
    const reaction = await startProcessingReactionForMessage({
      channelId: "C0PROCESSING",
      timestamp: slackTs("1700007303.000000"),
    });

    reaction.keep();
    await reaction.complete();

    expect(removeReactionFromMessage).not.toHaveBeenCalled();
    expect(addReactionToMessage).toHaveBeenCalledTimes(1);
    expect(addReactionToMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emoji: "eyes",
      }),
    );
  });

  it("logs a deleted message or ack timeout as a warning and captures other failures", async () => {
    addReactionToMessage
      .mockRejectedValueOnce(
        new SlackActionError(
          "An API error occurred: message_not_found",
          "not_found",
          { apiError: "message_not_found" },
        ),
      )
      .mockRejectedValueOnce(
        new SlackActionError(
          "A request error occurred: timeout of 1000ms exceeded",
          "internal_error",
          {
            cause: {
              code: "slack_webapi_request_error",
              original: { code: "ECONNABORTED" },
            },
          },
        ),
      )
      .mockRejectedValueOnce(
        new SlackActionError(
          "An API error occurred: invalid_auth",
          "internal_error",
          {
            apiError: "invalid_auth",
          },
        ),
      );

    for (const ts of [
      "1700007304.000000",
      "1700007305.000000",
      "1700007306.000000",
    ]) {
      await startProcessingReactionForMessage({
        channelId: "C0PROCESSING",
        timestamp: slackTs(ts),
        timeoutMs: 1_000,
      });
    }

    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logException).toHaveBeenCalledTimes(1);
    expect(logException).toHaveBeenCalledWith(
      expect.objectContaining({ apiError: "invalid_auth" }),
      "slack.processing.reaction_add.failed",
      expect.any(Object),
    );
  });
});
