import { createSlackSource } from "@sentry/junior-plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planToolExposure } from "@/chat/tool-exposure";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const { cancelSubscriptions, createSubscription, listSubscriptions } =
  vi.hoisted(() => ({
    cancelSubscriptions: vi.fn(),
    createSubscription: vi.fn(),
    listSubscriptions: vi.fn(),
  }));

vi.mock("@/chat/resource-events/store", () => ({
  cancelSubscriptions,
  createResourceEventSubscription: createSubscription,
  listResourceEventSubscriptions: listSubscriptions,
}));

import { createResourceEventTools } from "@/chat/tools/resource-events";

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
    cancelSubscriptions.mockReset();
    cancelSubscriptions.mockResolvedValue(undefined);
    createSubscription.mockReset();
    createSubscription.mockResolvedValue({
      id: "subscription-1",
      status: "active",
      resourceRef: "github:pull_request:getsentry/junior#1",
      events: ["checks.failed", "review.changes_requested"],
      expiresAtMs: 1_800_000_000_000,
    });
    listSubscriptions.mockReset();
    listSubscriptions.mockResolvedValue(subscriptions);
  });

  it("returns the inverse action after creating a resource watch", async () => {
    const tool = createResourceEventTools(context).subscribeToResourceEvents!;

    await expect(
      tool.execute!(
        {
          resourceRef: "github:pull_request:getsentry/junior#1",
          provider: "github",
          resourceType: "pull_request",
          label: "GitHub PR #1",
          events: ["checks.failed", "review.changes_requested"],
          intent: "Report failed checks and requested changes.",
        },
        {},
      ),
    ).resolves.toMatchObject({
      subscription_status: "active",
      stop_watching: {
        execution_tool: "executeTool",
        execution_example: {
          tool_name: "stopWatchingResources",
          arguments: {},
        },
      },
    });
  });

  it("keeps inspection and stopping in the resource-watch catalog", () => {
    const tools = createResourceEventTools(context);
    const exposure = planToolExposure(tools);

    expect(exposure.directTools).toHaveProperty("subscribeToResourceEvents");
    expect(exposure.directTools).not.toHaveProperty(
      "listResourceEventSubscriptions",
    );
    expect(exposure.directTools).not.toHaveProperty("stopWatchingResources");
    expect(exposure.catalogTools).toHaveProperty(
      "listResourceEventSubscriptions",
    );
    expect(exposure.catalogTools.stopWatchingResources).toMatchObject({
      source: { id: "resource-watches" },
    });
  });

  it("stops every resource watch for the current conversation", async () => {
    const tool = createResourceEventTools(context).stopWatchingResources!;

    await expect(tool.execute!({}, {})).resolves.toMatchObject({
      watching_status: "stopped",
    });
    expect(cancelSubscriptions).toHaveBeenCalledTimes(1);
    expect(cancelSubscriptions).toHaveBeenCalledWith({
      conversationId: "slack:C123:1712345.0001",
    });
    expect(listSubscriptions).not.toHaveBeenCalled();
  });
});
