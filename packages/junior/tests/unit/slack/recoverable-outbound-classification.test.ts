import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock("@/chat/slack/client", () => ({
  SlackActionError: class SlackActionError extends Error {},
  getSlackClient: () => ({
    chat: { postMessage: mocks.postMessage },
  }),
  normalizeSlackConversationId: (value: string) => value,
  withSlackRetries: vi.fn(),
}));

import {
  parseSlackDeliveryLocator,
  postRecoverableSlackMessage,
  type SlackDeliveryMetadata,
} from "@/chat/slack/outbound";

function deliveryMetadata(): SlackDeliveryMetadata {
  const locator = parseSlackDeliveryLocator("abcdefghijklmnopqrstuv");
  if (!locator) throw new Error("Test delivery locator must be valid");
  return { locator, partIndex: 0, version: 1 };
}

describe("recoverable Slack post failure classification", () => {
  beforeEach(() => {
    mocks.postMessage.mockReset();
  });

  it.each([
    ["timeout", { code: "ETIMEDOUT", message: "request timed out" }],
    ["reset", { code: "ECONNRESET", message: "socket hang up" }],
    ["socket hangup", new Error("socket hang up")],
  ])(
    "makes one transport attempt for an ambiguous %s",
    async (_name, error) => {
      mocks.postMessage.mockRejectedValueOnce(error);

      await expect(
        postRecoverableSlackMessage({
          channelId: "C123",
          threadTs: "1700000000.000100",
          text: "hello",
          metadata: deliveryMetadata(),
        }),
      ).resolves.toEqual({
        outcome: "uncertain",
        reason: "transport_error",
      });
      expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    },
  );
});
