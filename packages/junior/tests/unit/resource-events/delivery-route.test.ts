import { beforeEach, describe, expect, it, vi } from "vitest";

const getConversation = vi.fn();

vi.mock("@/chat/db", () => ({
  getConversationStore: () => ({
    get: getConversation,
  }),
}));

import { resolveResourceEventDeliveryRoute } from "@/chat/resource-events/notification";

const destination = {
  platform: "slack" as const,
  teamId: "T123",
  channelId: "C123",
};

describe("resource event delivery route", () => {
  beforeEach(() => {
    getConversation.mockReset();
  });

  it("uses the conversation id when it already names the Slack thread", async () => {
    getConversation.mockResolvedValue(undefined);

    await expect(
      resolveResourceEventDeliveryRoute({
        conversationId: "slack:C123:1712345.0001",
        destination,
      }),
    ).resolves.toEqual({
      destination,
      threadTs: "1712345.0001",
    });
  });

  it("uses the root conversation session for agent children", async () => {
    getConversation.mockImplementation(async ({ conversationId }) => {
      if (conversationId === "agent:child") {
        return {
          conversationId: "agent:child",
          lineage: { parentConversationId: "slack:C123:1712345.0001" },
        };
      }
      if (conversationId === "slack:C123:1712345.0001") {
        return {
          conversationId: "slack:C123:1712345.0001",
          destination,
          sessionSource: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
            threadTs: "1712345.0001",
            visibility: "public",
          },
        };
      }
      return undefined;
    });

    await expect(
      resolveResourceEventDeliveryRoute({
        conversationId: "agent:child",
        destination,
      }),
    ).resolves.toEqual({
      destination,
      threadTs: "1712345.0001",
    });
  });

  it("returns undefined when no Slack route exists", async () => {
    getConversation.mockResolvedValue({
      conversationId: "agent:child",
      lineage: { parentConversationId: "local:web:abc" },
    });

    await expect(
      resolveResourceEventDeliveryRoute({
        conversationId: "agent:child",
        destination: {
          platform: "local",
          conversationId: "local:web:abc",
        },
      }),
    ).resolves.toBeUndefined();
  });
});
