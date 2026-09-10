import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  createSlackSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { createTools } from "@/chat/tools";
import { readSlackActionToken } from "@/chat/slack/action-token";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { setPlugins } from "@/chat/plugins/agent-hooks";
const noopSandbox = {} as any;
const actionToken = readSlackActionToken({
  raw: { action_token: "action-123" },
});
if (!actionToken) {
  throw new Error("test action token did not parse");
}
const noopEgress = {
  async fetch() {
    return new Response("ok");
  },
};

function eventPlugin(enabled = true) {
  return defineJuniorPlugin({
    manifest: {
      name: "events-test",
      displayName: "Events test",
      description: "Publishes test events",
    },
    events: {
      resourceTypes: [{ type: "issue", supportedEvents: ["issue.closed"] }],
      isEnabled: () => enabled,
    },
  });
}

function ctx(): Extract<ToolRuntimeContext, { source: { kind: "local" } }>;
function ctx(
  channelId: string,
  sourceVisibility?: "private" | "public",
): Extract<ToolRuntimeContext, { source: { kind: "slack" } }>;
function ctx(
  channelId?: string,
  sourceVisibility?: "private" | "public",
): ToolRuntimeContext {
  if (!channelId) {
    return {
      conversationId: "local:test:tool-registration",
      destination: {
        platform: "local" as const,
        conversationId: "local:test:tool-registration",
      },
      egress: noopEgress,
      source: createLocalSource("local:test:tool-registration"),
      workspace: noopSandbox,
    };
  }

  return {
    conversationId: `slack:${channelId}:1700000000.100000`,
    conversationPrivacy:
      sourceVisibility ?? (channelId.startsWith("C") ? "public" : "private"),
    slackActionToken: actionToken,
    destination: {
      platform: "slack" as const,
      teamId: "T123",
      channelId,
    },
    source: createSlackSource({
      teamId: "T123",
      channelId,
      visibility:
        sourceVisibility ?? (channelId.startsWith("C") ? "public" : "private"),
    }),
    location: {
      id: `location:T123:${channelId}`,
      provider: "slack",
      teamId: "T123",
      channelId,
      threadTs: "1700000000.100000",
    },
    egress: noopEgress,
    workspace: noopSandbox,
  };
}

describe("Slack tool registration", () => {
  beforeEach(() => {
    setPlugins([]);
  });

  afterEach(() => {
    setPlugins([]);
    vi.restoreAllMocks();
  });

  it("lists only plugins that can verify identity accounts", () => {
    setPlugins([
      eventPlugin(),
      defineJuniorPlugin({
        manifest: {
          name: "identity-test",
          displayName: "Identity test",
          description: "Verifies test accounts",
        },
        hooks: {
          resolveOAuthAccount: () => ({ id: "account-1" }),
        },
      }),
    ]);

    const tools = createTools([], {}, ctx("D12345"));
    expect(tools.userLookup?.inputSchema).toMatchObject({
      properties: {
        provider: { enum: ["slack", "identity-test"] },
      },
    });
  });

  it("omits loadSkill when an explicit skill is already loaded", () => {
    const tools = createTools([], {}, ctx("D12345"), {
      includeLoadSkill: false,
    });

    expect(tools).not.toHaveProperty("loadSkill");
  });

  it("registers thread sendFiles and channel history in DM context", () => {
    const tools = createTools([], {}, ctx("D12345"));

    expect(tools).toHaveProperty("sendFiles");
    const sendFilesTool = tools.sendFiles;
    if (!sendFilesTool) {
      throw new Error("sendFiles tool missing");
    }
    expect(sendFilesTool.inputSchema).not.toHaveProperty("properties.target");
    expect(sendFilesTool.inputSchema).toMatchObject({
      required: expect.arrayContaining(["files"]),
    });
    expect(tools).not.toHaveProperty("attachFile");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("searchConversationMessages");
    expect(tools).toHaveProperty("searchConversationEvents");
    expect(tools.searchConversationEvents?.exposure).toBe("deferred");
    expect(tools.searchConversationEvents?.source?.id).toBe("conversations");
  });

  it("registers channel-scope tools in shared channel context", () => {
    const tools = createTools([], {}, ctx("C12345"));

    expect(tools).toHaveProperty("sendFiles");
    expect(tools).not.toHaveProperty("attachFile");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackPublicSearch");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
    expect(tools).toHaveProperty("searchConversationMessages");
    expect(tools).toHaveProperty("searchConversationEvents");
    expect(tools).toHaveProperty("stopWatchingResources");
    expect(tools).toHaveProperty("listWatches");
    expect(tools.searchConversationMessages?.exposure).toBe("deferred");
    expect(tools.searchConversationMessages?.source?.id).toBe("conversations");
    expect(tools.searchConversationEvents?.exposure).toBe("deferred");
    expect(tools.searchConversationEvents?.source?.id).toBe("conversations");
    expect(tools.stopWatchingResources?.exposure).toBe("deferred");
    expect(tools.listWatches?.exposure).toBe("deferred");
  });

  it("still registers public search without an action token", () => {
    const context = ctx("C12345");
    delete context.slackActionToken;
    const tools = createTools([], {}, context);

    expect(tools).toHaveProperty("slackPublicSearch");
    expect(tools).toHaveProperty("slackChannelJoin");
  });

  it("does not register conversation search for a private Conversation", () => {
    const tools = createTools([], {}, ctx("C12345", "private"));

    expect(tools).not.toHaveProperty("searchConversationMessages");
  });

  it("registers tools when runtime channel ids are Junior Slack references", () => {
    const tools = createTools([], {}, ctx("slack:C12345"));

    expect(tools).toHaveProperty("sendFiles");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("keeps active-conversation sendFiles outside interactive Slack turns", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        surface: "api",
      },
    );

    expect(tools).toHaveProperty("sendFiles");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackThreadRead");
  });

  it("registers Slack tools for system work in a Slack Conversation", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        actor: { platform: "system", name: "scheduler" },
        source: { kind: "scheduled_automation" },
        slackActionToken: undefined,
      },
    );

    expect(tools).toHaveProperty("slackThreadRead");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("sendFiles");
    expect(tools).not.toHaveProperty("slackPublicSearch");
    expect(tools).not.toHaveProperty("addReaction");
  });

  it("registers delivery tools from assistant context channel in DM turns", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("D12345"),
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C12345",
        },
      },
    );

    expect(tools).toHaveProperty("sendFiles");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("registers schedule tools only with complete Slack turn context", () => {
    setPlugins([eventPlugin()]);
    const incomplete = createTools([], {}, ctx("C12345"));
    const complete = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C12345",
        },
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
        resolveActorIdentity: async () => ({
          identity: {
            id: "identity:T123:U123",
            provider: "slack",
            providerSubjectId: "U123",
            providerTenantId: "T123",
          },
        }),
      },
    );

    expect(incomplete).not.toHaveProperty("slackScheduleCreateAutomation");
    expect(incomplete).not.toHaveProperty("createEventAutomation");
    expect(incomplete).toHaveProperty("searchEventTypes");
    expect(incomplete).toHaveProperty("watchEvents");
    expect(complete).toHaveProperty("slackScheduleCreateAutomation");
    expect(complete).toHaveProperty("slackScheduleListAutomations");
    expect(complete).toHaveProperty("slackScheduleUpdateAutomation");
    expect(complete).toHaveProperty("slackScheduleDeleteAutomation");
    expect(complete).toHaveProperty("slackScheduleRunAutomationNow");
    expect(complete).toHaveProperty("createEventAutomation");
    expect(complete).toHaveProperty("searchEventTypes");
    expect(complete).toHaveProperty("watchEvents");
    expect(complete).toHaveProperty("listEventAutomations");
    expect(complete).toHaveProperty("updateEventAutomation");
    expect(complete).toHaveProperty("deleteEventAutomation");
  });

  it("keeps event automation management but not creation without an active event plugin", () => {
    setPlugins([eventPlugin(false)]);
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        actor: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
      },
    );

    // Core Workspace snapshot events stay searchable/watchable. Durable event
    // task creation still needs a plugin publisher.
    expect(tools).not.toHaveProperty("createEventAutomation");
    expect(tools).toHaveProperty("searchEventTypes");
    expect(tools).toHaveProperty("watchEvents");
    expect(tools).toHaveProperty("listEventAutomations");
    expect(tools).toHaveProperty("updateEventAutomation");
    expect(tools).toHaveProperty("deleteEventAutomation");
  });

  it("does not register schedule tools without a actor", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
      },
    );

    expect(tools).not.toHaveProperty("slackScheduleCreateAutomation");
    expect(tools).not.toHaveProperty("slackScheduleListAutomations");
    expect(tools).not.toHaveProperty("slackScheduleUpdateAutomation");
    expect(tools).not.toHaveProperty("slackScheduleDeleteAutomation");
    expect(tools).not.toHaveProperty("slackScheduleRunAutomationNow");
    expect(tools).not.toHaveProperty("createEventAutomation");
  });

  it("does not register canvas create when channel context is unavailable", () => {
    const tools = createTools([], {}, ctx());

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackCanvasRead");
    expect(tools).not.toHaveProperty("sendFiles");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).not.toHaveProperty("addReaction");
  });

  it("does not register Slack tools for local destinations", () => {
    const tools = createTools(
      [],
      {},
      {
        conversationId: "local:test:run-test",
        destination: {
          platform: "local",
          conversationId: "local:test:run-test",
        },
        egress: noopEgress,
        source: createLocalSource("local:test:run-test"),
        workspace: noopSandbox,
      },
    );

    expect(
      Object.keys(tools).filter((name) => name.startsWith("slack")),
    ).toEqual([]);
    expect(tools).not.toHaveProperty("attachFile");
    expect(tools).toHaveProperty("stopWatchingResources");
    expect(tools).toHaveProperty("searchConversationEvents");
  });

  it("registers image generation only when artifact persistence is available", () => {
    expect(createTools([], {}, ctx())).not.toHaveProperty("imageGenerate");

    const tools = createTools(
      [],
      {
        writeGeneratedArtifacts: async () => [],
      },
      ctx(),
    );

    expect(tools).toHaveProperty("imageGenerate");
  });
});
