import { createSlackSource } from "@sentry/junior-plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planToolExposure } from "@/chat/tool-exposure";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const {
  cancelSubscription,
  cancelSubscriptions,
  createSubscription,
  listSubscriptions,
} = vi.hoisted(() => ({
  cancelSubscription: vi.fn(),
  cancelSubscriptions: vi.fn(),
  createSubscription: vi.fn(),
  listSubscriptions: vi.fn(),
}));

vi.mock("@/chat/resource-events/store", () => ({
  cancelResourceEventSubscription: cancelSubscription,
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
    visibility: "public",
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
    identifier: "getsentry/junior#1",
  },
  {
    id: "subscription-2",
    label: "GitHub PR #2",
    identifier: "getsentry/junior#2",
  },
];
const GITHUB_EVENTS = {
  github: {
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: [
          "pull_request.checks.failed",
          "pull_request.review.changes_requested",
        ],
        suggestedEvents: ["pull_request.checks.failed"],
      },
    ],
    normalizeIdentifier: (identifier: string) => identifier.toLowerCase(),
  },
};

describe("resource event tools", () => {
  beforeEach(() => {
    cancelSubscription.mockReset();
    cancelSubscription.mockResolvedValue({
      id: "subscription-1",
      status: "cancelled",
    });
    cancelSubscriptions.mockReset();
    cancelSubscriptions.mockResolvedValue(undefined);
    createSubscription.mockReset();
    createSubscription.mockResolvedValue({
      id: "subscription-1",
      status: "active",
      identifier: "getsentry/junior#1",
      events: [
        "pull_request.checks.failed",
        "pull_request.review.changes_requested",
      ],
      expiresAtMs: 1_800_000_000_000,
    });
    listSubscriptions.mockReset();
    listSubscriptions.mockResolvedValue(subscriptions);
  });

  it("returns the inverse action after creating a resource watch", async () => {
    const tool = createResourceEventTools(
      context,
      GITHUB_EVENTS,
    ).watchResourceEvents!;

    await expect(
      tool.execute!(
        {
          identifier: "GetSentry/Junior#1",
          namespace: "github",
          resourceType: "pull_request",
          label: "GitHub PR #1",
          events: [
            "pull_request.checks.failed",
            "pull_request.review.changes_requested",
          ],
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
          arguments: { id: "subscription-1" },
        },
      },
    });
    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ identifier: "getsentry/junior#1" }),
    );
  });

  it("keeps inspection and stopping in the resource-watch catalog", () => {
    const tools = createResourceEventTools(context, GITHUB_EVENTS);
    const exposure = planToolExposure(tools);

    expect(exposure.directTools).toHaveProperty("searchResourceEventTypes");
    expect(exposure.directTools).toHaveProperty("watchResourceEvents");
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

  it("searches enabled resource event types without creating a watch", async () => {
    const tools = createResourceEventTools(context, {
      vercel: {
        resourceTypes: [
          {
            type: "deployment",
            supportedEvents: ["deployment.succeeded"],
          },
        ],
      },
      ...GITHUB_EVENTS,
    });

    await expect(
      tools.searchResourceEventTypes!.execute!(
        { query: "review changes", namespace: "github" },
        {},
      ),
    ).resolves.toMatchObject({
      namespace: "github",
      totalMatches: 1,
      resourceTypes: [
        {
          namespace: "github",
          type: "pull_request",
          supportedEvents: [
            "pull_request.checks.failed",
            "pull_request.review.changes_requested",
          ],
          suggestedEvents: ["pull_request.checks.failed"],
        },
      ],
    });
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("exposes active plugin namespaces as an enum", () => {
    const tool = createResourceEventTools(context, {
      vercel: {
        resourceTypes: [
          {
            type: "deployment",
            supportedEvents: ["deployment.succeeded"],
          },
        ],
      },
      ...GITHUB_EVENTS,
    }).watchResourceEvents!;

    expect(tool.inputSchema).toMatchObject({
      properties: {
        events: {
          items: {
            enum: [
              "deployment.succeeded",
              "pull_request.checks.failed",
              "pull_request.review.changes_requested",
            ],
          },
        },
        namespace: { enum: ["github", "vercel"] },
        resourceType: { enum: ["deployment", "pull_request"] },
      },
    });
  });

  it("rejects events unsupported by the selected resource type", async () => {
    const tool = createResourceEventTools(context, {
      github: {
        resourceTypes: [
          { type: "issue", supportedEvents: ["issue.closed"] },
          {
            type: "pull_request",
            supportedEvents: ["pull_request.merged"],
          },
        ],
      },
    }).watchResourceEvents!;

    await expect(
      tool.execute!(
        {
          identifier: "getsentry/junior#1",
          namespace: "github",
          resourceType: "issue",
          label: "GitHub issue #1",
          events: ["pull_request.merged"],
          intent: "Report closure.",
        },
        {},
      ),
    ).rejects.toThrow(/github:issue.*does not support event/);
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("rejects a watch duration over 30 days instead of shortening it", async () => {
    const tool = createResourceEventTools(
      context,
      GITHUB_EVENTS,
    ).watchResourceEvents!;

    await expect(
      tool.execute!(
        {
          identifier: "getsentry/junior#1",
          namespace: "github",
          resourceType: "pull_request",
          label: "GitHub PR #1",
          events: ["pull_request.checks.failed"],
          intent: "Report failed checks.",
          ttlMs: 31 * 24 * 60 * 60 * 1000,
        },
        {},
      ),
    ).rejects.toThrow("Resource watches cannot exceed 30 days");
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("stops one selected resource watch", async () => {
    const tool = createResourceEventTools(
      context,
      GITHUB_EVENTS,
    ).stopWatchingResources!;

    await expect(
      tool.execute!({ id: "subscription-1" }, {}),
    ).resolves.toMatchObject({
      watching_status: "stopped",
      stoppedIds: ["subscription-1"],
    });
    expect(cancelSubscription).toHaveBeenCalledWith({
      conversationId: "slack:C123:1712345.0001",
      id: "subscription-1",
    });
    expect(cancelSubscriptions).not.toHaveBeenCalled();
    expect(listSubscriptions).not.toHaveBeenCalled();
  });

  it("stops every resource watch when no watch id is selected", async () => {
    const tool = createResourceEventTools(
      context,
      GITHUB_EVENTS,
    ).stopWatchingResources!;

    await expect(tool.execute!({ id: null }, {})).resolves.toMatchObject({
      watching_status: "stopped",
      stoppedIds: ["subscription-1", "subscription-2"],
    });
    expect(cancelSubscriptions).toHaveBeenCalledTimes(1);
    expect(cancelSubscriptions).toHaveBeenCalledWith({
      conversationId: "slack:C123:1712345.0001",
    });
    expect(listSubscriptions).toHaveBeenCalledWith({
      conversationId: "slack:C123:1712345.0001",
    });
  });
});
