import { beforeEach, describe, expect, it, vi } from "vitest";

const withSlackRetries = vi.fn();
const getSlackClient = vi.fn();

vi.mock("@/chat/slack-actions/client", () => ({
  getSlackClient: () => getSlackClient(),
  normalizeSlackConversationId: (value: string | undefined) => value,
  withSlackRetries: (...args: unknown[]) => withSlackRetries(...args)
}));

import { addReactionToMessage } from "@/chat/slack-actions/channel";

describe("slack channel action context", () => {
  beforeEach(() => {
    withSlackRetries.mockReset();
    getSlackClient.mockReset();
  });

  it("passes reaction action context into retry wrapper", async () => {
    const reactionsAdd = vi.fn(async () => ({ ok: true }));
    getSlackClient.mockReturnValue({
      reactions: {
        add: reactionsAdd
      }
    });

    withSlackRetries.mockImplementation(async (task: () => Promise<unknown>) => await task());

    await addReactionToMessage({
      channelId: "C123",
      timestamp: "1700000000.100",
      emoji: "thumbsup"
    });

    expect(withSlackRetries).toHaveBeenCalledWith(expect.any(Function), 3, {
      action: "reactions.add"
    });
  });
});
