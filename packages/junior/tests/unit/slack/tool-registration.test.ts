import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindAgentTools } from "@/chat/agent/tools";
import type { AgentRun } from "@/chat/agent/types";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import {
  createEventSource,
  createLocalSource,
  createSlackSource,
  defineJuniorPlugin,
} from "@sentry/junior-plugin-api";
import { createTools } from "@/chat/tool-support/create-tools";
import { readSlackActionToken } from "@/chat/slack/action-token";
import type { ToolRuntimeContext } from "@/chat/tool-support/types";
import { createApp } from "@/app";
import { useAppContext } from "../../fixtures/app-context";

const rootTurnTools = turnBehavior({
  kind: "thread",
  hasParent: false,
  personInput: true,
}).tools;
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

function eventPlugin() {
  return defineJuniorPlugin({
    manifest: {
      name: "events-test",
      displayName: "Events test",
      description: "Publishes test events",
    },
    events: {
      resourceTypes: [{ type: "issue", supportedEvents: ["issue.closed"] }],
      events: { "issue.closed": { reach: "resource" } },
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
      turnTools: rootTurnTools,
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
    turnTools: rootTurnTools,
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
    useAppContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("lists only plugins that can verify or search identity accounts", () => {
    useAppContext({
      plugins: [
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
        defineJuniorPlugin({
          manifest: {
            name: "search-test",
            displayName: "Search test",
            description: "Searches test accounts",
          },
          hooks: {
            searchUsers: () => [],
          },
        }),
      ],
    });

    const tools = createTools([], {}, ctx("D12345"));
    expect(tools["userLookup"]?.inputSchema).toMatchObject({
      properties: {
        provider: { enum: ["slack", "identity-test", "search-test"] },
      },
    });
  });

  it("registers thread sendFiles and channel history in DM context", () => {
    const tools = createTools([], {}, ctx("D12345"));

    expect(tools).toHaveProperty("sendFiles");
    const sendFilesTool = tools["sendFiles"];
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
    expect(tools["searchConversationEvents"]?.exposure).toBe("deferred");
    expect(tools["searchConversationEvents"]?.source?.id).toBe("conversations");
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
    expect(tools["searchConversationMessages"]?.exposure).toBe("deferred");
    expect(tools["searchConversationMessages"]?.source?.id).toBe(
      "conversations",
    );
    expect(tools["listAgents"]?.exposure).toBe("deferred");
    expect(tools["listAgents"]?.source?.id).toBe("agents");
    expect(tools["listAgents"]?.inputSchema["properties"]).toHaveProperty(
      "query",
    );
    expect(tools["searchConversationEvents"]?.exposure).toBe("deferred");
    expect(tools["searchConversationEvents"]?.source?.id).toBe("conversations");
    expect(tools["stopWatchingResources"]?.exposure).toBe("deferred");
    expect(tools["listWatches"]?.exposure).toBe("deferred");
  });

  it("still registers public search without an action token", () => {
    const context = ctx("C12345");
    delete context.slackActionToken;
    const tools = createTools([], {}, context);

    expect(tools).toHaveProperty("slackPublicSearch");
    expect(tools).toHaveProperty("slackChannelJoin");
  });

  it("does not register message search for a private Conversation", () => {
    const tools = createTools([], {}, ctx("C12345", "private"));

    expect(tools).not.toHaveProperty("searchConversationMessages");
    expect(tools).toHaveProperty("listAgents");
  });

  it("registers Conversation search outside Slack", () => {
    const tools = createTools(
      [],
      {},
      { ...ctx(), conversationPrivacy: "public" },
    );

    expect(tools).toHaveProperty("listAgents");
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

  it("registers the same tools for every Turn origin in a Slack Conversation", () => {
    useAppContext({ plugins: [eventPlugin()] });
    const slackActor = {
      platform: "slack" as const,
      teamId: "T123",
      userId: "U123",
    };
    const messageTurn = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        actor: slackActor,
      },
    );
    // The provider caches tools first. Every origin must send the same list,
    // or the next Turn writes the whole Conversation to the cache again.
    const modelView = (tools: ReturnType<typeof createTools>) =>
      JSON.stringify(
        Object.entries(tools).map(([name, tool]) => [
          name,
          tool.description,
          tool.inputSchema,
        ]),
      );
    const otherTurns = [
      {
        actor: { platform: "system" as const, name: "scheduler" },
        source: { kind: "scheduled_automation" as const },
      },
      {
        actor: { platform: "system" as const, name: "event" },
        source: createEventSource({
          eventKey: "event-1",
          eventType: "issue.closed",
          identifier: "issue-1",
          namespace: "events-test",
        }),
      },
      {
        actor: slackActor,
        source: { kind: "parent_message" as const },
      },
    ];

    for (const turn of otherTurns) {
      const tools = createTools(
        [],
        {},
        {
          ...ctx("C12345"),
          ...turn,
          slackActionToken: undefined,
        },
      );
      expect(modelView(tools)).toBe(modelView(messageTurn));
      expect(tools["createAutomation"]?.disabledReason).toBeDefined();
      expect(tools["addReaction"]?.disabledReason).toBeDefined();
      expect(tools["addInboxItem"]?.disabledReason).toBeUndefined();
    }
    expect(messageTurn["createAutomation"]?.disabledReason).toBeUndefined();
    expect(messageTurn).toHaveProperty("loadSkill");
    expect(messageTurn).toHaveProperty("slackPublicSearch");
    expect(messageTurn).toHaveProperty("addReaction");
    expect(
      Object.keys(messageTurn).filter((name) => /Automation/.test(name)),
    ).toEqual([
      "createAutomation",
      "searchAutomations",
      "updateAutomation",
      "deleteAutomation",
      "runAutomationNow",
    ]);
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

  it("does not register canvas create when channel context is unavailable", () => {
    const tools = createTools([], {}, ctx());

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackCanvasRead");
    expect(tools).not.toHaveProperty("sendFiles");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).not.toHaveProperty("addReaction");
  });

  it("loads the tool that asks a person in every root Turn", () => {
    const tools = createTools([], {}, ctx());
    expect(tools["addInboxItem"]?.exposure).not.toBe("deferred");
    expect(tools["addInboxItem"]?.disabledReason).toBeUndefined();

    // A child agent reports the need to its parent.
    const childTools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        parentConversationId: "slack:C12345:1700000000.000",
        turnTools: turnBehavior({
          kind: "task",
          hasParent: true,
          personInput: false,
        }).tools,
      },
    );
    expect(childTools["addInboxItem"]?.disabledReason).toContain(
      "reportBlocked",
    );
  });

  it("does not register Slack tools for local destinations", () => {
    const tools = createTools(
      [],
      {},
      {
        turnTools: rootTurnTools,
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
    // Automation tools are not Slack tools. This Turn has no person, so they
    // are disabled.
    expect(tools["createAutomation"]?.disabledReason).toBeDefined();
    expect(tools["runAutomationNow"]?.disabledReason).toBeDefined();
    expect(tools).not.toHaveProperty("attachFile");
    expect(tools).toHaveProperty("stopWatchingResources");
    expect(tools).toHaveProperty("searchConversationEvents");
  });

  it("registers image generation only when artifact persistence is available", () => {
    expect(createTools([], {}, ctx())).not.toHaveProperty("imageGenerate");

    const tools = createTools(
      [],
      {
        writeGeneratedFiles: async () => [],
      },
      ctx(),
    );

    expect(tools).toHaveProperty("imageGenerate");
  });
});

describe("agent tool binding", () => {
  afterEach(async () => {
    // Restore the default maxAgentDepth, 2.
    await createApp();
  });

  // Binding reads only the Run's environment, the Turn's agent tools and
  // maxAgentDepth, so a child gets the same tools on every path.
  function agentRun() {
    const spawnAgent = vi.fn();
    const messageAgent = vi.fn();
    const environment = {
      bindSpawnAgent: vi.fn(() => spawnAgent),
      bindMessageAgent: vi.fn(() => messageAgent),
    };
    return {
      environment,
      messageAgent,
      run: {
        conversationId: "local:agent-tools",
        turnId: "turn-agent-tools",
        instruction: { text: "hello" },
        source: createLocalSource("local:agent-tools"),
        destination: { platform: "local", conversationId: "local:agent-tools" },
        environment,
      } satisfies AgentRun,
      spawnAgent,
    };
  }

  // A root always spawns. A child spawns only when maxAgentDepth is above 0,
  // and it can always message its parent. A root's messageAgent rejects
  // `parent` when it is called, as the root has no parent agent.
  it.each([
    { agents: "children", maxAgentDepth: 0, spawns: true },
    { agents: "children_and_parent", maxAgentDepth: 0, spawns: false },
    { agents: "children_and_parent", maxAgentDepth: 1, spawns: true },
  ] as const)(
    "binds spawnAgent for $agents with maxAgentDepth $maxAgentDepth: $spawns",
    async ({ agents, maxAgentDepth, spawns }) => {
      await createApp({ limits: { maxAgentDepth } });
      const { environment, messageAgent, run, spawnAgent } = agentRun();

      expect(bindAgentTools(run, agents)).toEqual(
        spawns ? { spawnAgent, messageAgent } : { messageAgent },
      );
      expect(environment.bindMessageAgent).toHaveBeenCalledWith(run, agents);
    },
  );
});
