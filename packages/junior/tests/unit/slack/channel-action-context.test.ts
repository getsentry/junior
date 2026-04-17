import { beforeEach, describe, expect, it, vi } from "vitest";

const { SlackActionErrorMock, withSlackRetries, getSlackClient } = vi.hoisted(
  () => ({
    SlackActionErrorMock: class SlackActionError extends Error {
      code: string;

      constructor(message: string, code: string) {
        super(message);
        this.name = "SlackActionError";
        this.code = code;
      }
    },
    withSlackRetries: vi.fn(),
    getSlackClient: vi.fn(),
  }),
);

vi.mock("@/chat/slack/client", () => ({
  SlackActionError: SlackActionErrorMock,
  getSlackClient: () => getSlackClient(),
  normalizeSlackConversationId: (value: string | undefined) => value,
  withSlackRetries: (...args: unknown[]) => withSlackRetries(...args),
}));

import {
  addReactionToMessage,
  postSlackMessage,
  removeReactionFromMessage,
  slackOutboundPolicy,
} from "@/chat/slack/outbound";

describe("slack outbound boundary", () => {
  beforeEach(() => {
    withSlackRetries.mockReset();
    getSlackClient.mockReset();
  });

  it("passes reaction action context into retry wrapper", async () => {
    const reactionsAdd = vi.fn(async () => ({ ok: true }));
    getSlackClient.mockReturnValue({
      reactions: {
        add: reactionsAdd,
      },
    });

    withSlackRetries.mockImplementation(
      async (task: () => Promise<unknown>) => await task(),
    );

    await addReactionToMessage({
      channelId: "C123",
      timestamp: "1700000000.100",
      emoji: "thumbsup",
    });

    expect(withSlackRetries).toHaveBeenCalledWith(expect.any(Function), 3, {
      action: "reactions.add",
    });
    expect(reactionsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "thumbsup",
      }),
    );
  });

  it("passes reaction removal action context into retry wrapper", async () => {
    const reactionsRemove = vi.fn(async () => ({ ok: true }));
    getSlackClient.mockReturnValue({
      reactions: {
        remove: reactionsRemove,
      },
    });

    withSlackRetries.mockImplementation(
      async (task: () => Promise<unknown>) => await task(),
    );

    await removeReactionFromMessage({
      channelId: "C123",
      timestamp: "1700000000.100",
      emoji: "eyes",
    });

    expect(withSlackRetries).toHaveBeenCalledWith(expect.any(Function), 3, {
      action: "reactions.remove",
    });
  });

  it("preserves Slack skin-tone modifiers when adding reactions", async () => {
    const reactionsAdd = vi.fn(async () => ({ ok: true }));
    getSlackClient.mockReturnValue({
      reactions: {
        add: reactionsAdd,
      },
    });

    withSlackRetries.mockImplementation(
      async (task: () => Promise<unknown>) => await task(),
    );

    await addReactionToMessage({
      channelId: "C123",
      timestamp: "1700000000.100",
      emoji: ":thumbsup::skin-tone-6:",
    });

    expect(reactionsAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "thumbsup::skin-tone-6",
      }),
    );
  });

  it("treats already_reacted as idempotent success", async () => {
    withSlackRetries.mockRejectedValue(
      new SlackActionErrorMock("already reacted", "already_reacted"),
    );

    await expect(
      addReactionToMessage({
        channelId: "C123",
        timestamp: "1700000000.100",
        emoji: "thumbsup",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("treats no_reaction as idempotent success", async () => {
    withSlackRetries.mockRejectedValue(
      new SlackActionErrorMock("no reaction", "no_reaction"),
    );

    await expect(
      removeReactionFromMessage({
        channelId: "C123",
        timestamp: "1700000000.100",
        emoji: "thumbsup",
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("posts messages with mrkdwn and best-effort permalink lookup", async () => {
    const postMessage = vi.fn(async () => ({ ts: "1700000000.200" }));
    const getPermalink = vi.fn(async () => ({
      permalink: "https://example.invalid/message",
    }));
    getSlackClient.mockReturnValue({
      chat: {
        postMessage,
        getPermalink,
      },
    });

    withSlackRetries.mockImplementation(
      async (task: () => Promise<unknown>) => await task(),
    );

    await expect(
      postSlackMessage({
        channelId: "C123",
        threadTs: "1700000000.100",
        text: "Hello from Slack",
        includePermalink: true,
      }),
    ).resolves.toEqual({
      ts: "1700000000.200",
      permalink: "https://example.invalid/message",
    });

    expect(postMessage).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1700000000.100",
      text: "Hello from Slack",
      mrkdwn: true,
    });
    expect(getPermalink).toHaveBeenCalledWith({
      channel: "C123",
      message_ts: "1700000000.200",
    });
  });

  it("rejects message text above Slack's truncation limit before posting", async () => {
    await expect(
      postSlackMessage({
        channelId: "C123",
        text: "a".repeat(slackOutboundPolicy.maxMessageTextChars + 1),
      }),
    ).rejects.toThrow("40000 character truncation limit");
    expect(withSlackRetries).not.toHaveBeenCalled();
  });
});
