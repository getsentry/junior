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
      kind: "slack",
      destination,
      threadTs: "1712345.0001",
      publishExternally: true,
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
      kind: "slack",
      destination,
      threadTs: "1712345.0001",
      publishExternally: true,
    });
  });

  it("wakes the conversation without Slack publish when destination is not Slack", async () => {
    getConversation.mockResolvedValue({
      conversationId: "local:web:abc",
      destination: {
        platform: "local",
        conversationId: "local:web:abc",
      },
    });

    await expect(
      resolveResourceEventDeliveryRoute({
        conversationId: "local:web:abc",
        destination: {
          platform: "local",
          conversationId: "local:web:abc",
        },
      }),
    ).resolves.toEqual({
      kind: "conversation",
      destination: {
        platform: "local",
        conversationId: "local:web:abc",
      },
      publishExternally: false,
    });
  });

  it("returns undefined when Slack destination has no thread", async () => {
    getConversation.mockResolvedValue({
      conversationId: "agent:child",
      lineage: { parentConversationId: "agent-dispatch:task" },
    });

    await expect(
      resolveResourceEventDeliveryRoute({
        conversationId: "agent:child",
        destination,
      }),
    ).resolves.toBeUndefined();
  });
});
