import { createSlackSource } from "@sentry/junior-plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const { cancelSubscription, listSubscriptions } = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
}));

vi.mock("@/chat/resource-events/store", () => ({
  cancelResourceEventSubscription: cancelSubscription,
  createResourceEventSubscription: vi.fn(),
  listResourceEventSubscriptions: listSubscriptions,
}));

import { createStopWatchingResourcesTool } from "@/chat/tools/resource-events";

const context: ToolRuntimeContext = {
  conversationId: "slack:C123:1712345.0001",
  destination: {
    platform: "slack",
    teamId: "T123",
    channelId: "C123",
  },
  source: createSlackSource({
    teamId: "T123",
    channelId: "C123",
    threadTs: "1712345.0001",
    type: "pub",
  }),
  egress: {
    async fetch() {
      return new Response("ok");
    },
  },
  workspace: {} as ToolRuntimeContext["workspace"],
};

const subscriptions = [
  {
    id: "subscription-1",
    label: "GitHub PR #1",
    resourceRef: "github:pull_request:getsentry/junior#1",
  },
  {
    id: "subscription-2",
    label: "GitHub PR #2",
    resourceRef: "github:pull_request:getsentry/junior#2",
  },
];

describe("resource event tools", () => {
  beforeEach(() => {
    cancelSubscription.mockReset();
    cancelSubscription.mockImplementation(async ({ id }) => ({
      id,
      status: "cancelled",
    }));
    listSubscriptions.mockReset();
    listSubscriptions.mockResolvedValue(subscriptions);
  });

  it("stops only the resource watches selected from conversation context", async () => {
    const tool = createStopWatchingResourcesTool(context);

    await expect(
      tool.execute!(
        {
          resourceRefs: ["github:pull_request:getsentry/junior#2"],
        },
        {},
      ),
    ).resolves.toMatchObject({
      stopped_count: 1,
      subscriptions: [
        {
          id: "subscription-2",
          resourceRef: "github:pull_request:getsentry/junior#2",
          subscription_status: "cancelled",
        },
      ],
    });
    expect(cancelSubscription).toHaveBeenCalledTimes(1);
    expect(cancelSubscription).toHaveBeenCalledWith({
      conversationId: "slack:C123:1712345.0001",
      id: "subscription-2",
    });
  });

  it("does not stop other watches when a requested resource is not active", async () => {
    const tool = createStopWatchingResourcesTool(context);

    await expect(
      tool.execute!(
        {
          resourceRefs: ["github:pull_request:getsentry/junior#404"],
        },
        {},
      ),
    ).rejects.toThrow(
      "No active resource watches matched: github:pull_request:getsentry/junior#404",
    );
    expect(cancelSubscription).not.toHaveBeenCalled();
  });
});
