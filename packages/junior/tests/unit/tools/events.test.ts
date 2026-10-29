import { createSlackSource } from "@sentry/junior-plugin-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planToolExposure } from "@/chat/tool-exposure";
import type { ToolRuntimeContext } from "@/chat/tools/types";

const { createSubscription } = vi.hoisted(() => ({
  createSubscription: vi.fn(),
}));

vi.mock("@/chat/events/store", () => ({
  createWatch: createSubscription,
}));

import { createEventTools } from "@/chat/tools/events";

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

describe("event tools", () => {
  beforeEach(() => {
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
  });

  it("returns the inverse action after creating a resource watch", async () => {
    const tool = createEventTools(context, GITHUB_EVENTS).watchEvents!;

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
      expect.objectContaining({
        conversationId: "slack:C123:1712345.0001",
        identifier: "getsentry/junior#1",
      }),
    );
  });

  it("stores the current conversation id for agent child turns", async () => {
    const tool = createEventTools(
      {
        ...context,
        conversationId: "agent:deadbeefcafebabe",
      },
      GITHUB_EVENTS,
    ).watchEvents!;

    await tool.execute!(
      {
        identifier: "getsentry/junior#1",
        namespace: "github",
        resourceType: "pull_request",
        label: "GitHub PR #1",
        events: ["pull_request.checks.failed"],
        intent: "Report failed checks.",
      },
      {},
    );

    expect(createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "agent:deadbeefcafebabe",
      }),
    );
  });

  it("keeps inspection and stopping in the resource-watch catalog", () => {
    const tools = createEventTools(context, GITHUB_EVENTS);
    const exposure = planToolExposure(tools);

    expect(exposure.directTools).toHaveProperty("searchEventTypes");
    expect(exposure.directTools).toHaveProperty("watchEvents");
    expect(exposure.directTools).not.toHaveProperty("listWatches");
    expect(exposure.directTools).not.toHaveProperty("stopWatchingResources");
    expect(exposure.catalogTools).toHaveProperty("listWatches");
    expect(exposure.catalogTools.stopWatchingResources).toMatchObject({
      source: { id: "resource-watches" },
    });
  });

  it("searches enabled event types without creating a watch", async () => {
    const authors = {
      kind: "string" as const,
      description: "GitHub usernames of the pull request authors",
      list: true as const,
      events: ["pull_request.checks.failed"],
    };
    const tools = createEventTools(context, {
      vercel: {
        resourceTypes: [
          {
            type: "deployment",
            supportedEvents: ["deployment.succeeded"],
          },
        ],
      },
      github: {
        ...GITHUB_EVENTS.github,
        resourceTypes: GITHUB_EVENTS.github.resourceTypes.map(
          (resourceType) => ({ ...resourceType, matchFields: { authors } }),
        ),
      },
    });

    await expect(
      // "events" names nothing in the catalog; the other terms still match.
      tools.searchEventTypes!.execute!({ query: "review changes events" }, {}),
    ).resolves.toMatchObject({
      namespace: null,
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
          // The agent needs `events` to pick events that the filter matches.
          matchFields: { authors },
        },
      ],
    });
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("exposes active plugin namespaces as an enum", () => {
    const tool = createEventTools(context, {
      vercel: {
        resourceTypes: [
          {
            type: "deployment",
            supportedEvents: ["deployment.succeeded"],
          },
        ],
      },
      ...GITHUB_EVENTS,
    }).watchEvents!;

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
    const tool = createEventTools(context, {
      github: {
        resourceTypes: [
          { type: "issue", supportedEvents: ["issue.closed"] },
          {
            type: "pull_request",
            supportedEvents: ["pull_request.merged"],
          },
        ],
      },
    }).watchEvents!;

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
    ).rejects.toThrow(
      /github issue watch cannot be created\. "pull_request\.merged" is not an event/,
    );
    expect(createSubscription).not.toHaveBeenCalled();
  });

  it("rejects a watch duration over 30 days instead of shortening it", async () => {
    const tool = createEventTools(context, GITHUB_EVENTS).watchEvents!;

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
    ).rejects.toThrow("Watches cannot exceed 30 days");
    expect(createSubscription).not.toHaveBeenCalled();
  });
});
