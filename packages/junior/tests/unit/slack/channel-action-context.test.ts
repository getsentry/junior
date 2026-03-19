import { beforeEach, describe, expect, it, vi } from "vitest";

const withSlackRetries = vi.fn();
const getSlackClient = vi.fn();

vi.mock("@/chat/slack-actions/client", () => ({
  getSlackClient: () => getSlackClient(),
  normalizeSlackConversationId: (value: string | undefined) => value,
  withSlackRetries: (...args: unknown[]) => withSlackRetries(...args),
}));

import {
  addReactionToMessage,
  removeReactionFromMessage,
} from "@/chat/slack-actions/channel";

describe("slack channel action context", () => {
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
});
