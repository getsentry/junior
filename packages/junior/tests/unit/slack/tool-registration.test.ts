import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { createTools } from "@/chat/tools";
import { readSlackActionToken } from "@/chat/slack/action-token";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { schedulerPlugin } from "@sentry/junior-scheduler";
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

function ctx(): Extract<ToolRuntimeContext, { source: { platform: "local" } }>;
function ctx(
  channelId: string,
  sourceType?: "priv" | "pub",
): Extract<ToolRuntimeContext, { source: { platform: "slack" } }>;
function ctx(
  channelId?: string,
  sourceType?: "priv" | "pub",
): ToolRuntimeContext {
  if (!channelId) {
    return {
      destination: {
        platform: "local" as const,
        conversationId: "local:test:tool-registration",
      },
      egress: noopEgress,
      source: createLocalSource("local:test:tool-registration"),
      sandbox: noopSandbox,
    };
  }

  return {
    conversationId: `slack:${channelId}:1700000000.100000`,
    slackActionToken: actionToken,
    destination: {
      platform: "slack" as const,
      teamId: "T123",
      channelId,
    },
    source: createSlackSource({
      teamId: "T123",
      channelId,
      type: sourceType ?? (channelId.startsWith("C") ? "pub" : "priv"),
    }),
    egress: noopEgress,
    sandbox: noopSandbox,
  };
}

describe("Slack tool registration", () => {
  beforeEach(() => {
    setPlugins([schedulerPlugin()]);
  });

  afterEach(() => {
    setPlugins([]);
    vi.restoreAllMocks();
  });

  it("registers thread sendMessage but not channel-only tools in DM context", () => {
    const tools = createTools([], {}, ctx("D12345"));

    expect(tools).toHaveProperty("sendMessage");
    const sendMessageTool = tools.sendMessage;
    if (!sendMessageTool) {
      throw new Error("sendMessage tool missing");
    }
    expect(sendMessageTool.inputSchema).not.toHaveProperty("properties.target");
    expect(tools).not.toHaveProperty("attachFile");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("searchConversationHistory");
  });

  it("registers channel-scope tools in shared channel context", () => {
    const tools = createTools([], {}, ctx("C12345"));

    expect(tools).toHaveProperty("sendMessage");
    expect(tools).not.toHaveProperty("attachFile");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackPublicSearch");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
    expect(tools).toHaveProperty("searchConversationHistory");
    expect(tools.searchConversationHistory?.exposure).toBe("deferred");
    expect(tools.searchConversationHistory?.source?.id).toBe(
      "conversation-history",
    );
  });

  it("does not register public search without an action token", () => {
    const context = ctx("C12345");
    delete context.slackActionToken;
    const tools = createTools([], {}, context);

    expect(tools).not.toHaveProperty("slackPublicSearch");
  });

  it("does not register conversation search for a source-confirmed private C channel", () => {
    const tools = createTools([], {}, ctx("C12345", "priv"));

    expect(tools).not.toHaveProperty("searchConversationHistory");
  });

  it("registers tools when runtime channel ids are Junior Slack references", () => {
    const tools = createTools([], {}, ctx("slack:C12345"));

    expect(tools).toHaveProperty("sendMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("keeps active-conversation sendMessage outside interactive Slack turns", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        surface: "api",
      },
    );

    expect(tools).toHaveProperty("sendMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackThreadRead");
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

    expect(tools).toHaveProperty("sendMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("addReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("registers schedule tools only with complete Slack turn context", () => {
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
      },
    );

    expect(incomplete).not.toHaveProperty("scheduler_slackScheduleCreateTask");
    expect(complete).toHaveProperty("scheduler_slackScheduleCreateTask");
    expect(complete).toHaveProperty("scheduler_slackScheduleListTasks");
    expect(complete).toHaveProperty("scheduler_slackScheduleUpdateTask");
    expect(complete).toHaveProperty("scheduler_slackScheduleDeleteTask");
    expect(complete).toHaveProperty("scheduler_slackScheduleRunTaskNow");
  });

  it("does not register schedule tools without a actor", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
      },
    );

    expect(tools).not.toHaveProperty("scheduler_slackScheduleCreateTask");
    expect(tools).not.toHaveProperty("scheduler_slackScheduleListTasks");
    expect(tools).not.toHaveProperty("scheduler_slackScheduleUpdateTask");
    expect(tools).not.toHaveProperty("scheduler_slackScheduleDeleteTask");
    expect(tools).not.toHaveProperty("scheduler_slackScheduleRunTaskNow");
  });

  it("does not register canvas create when channel context is unavailable", () => {
    const tools = createTools([], {}, ctx());

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackCanvasRead");
    expect(tools).not.toHaveProperty("sendMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).not.toHaveProperty("addReaction");
  });

  it("does not register Slack tools for local destinations", () => {
    const tools = createTools(
      [],
      {},
      {
        destination: {
          platform: "local",
          conversationId: "local:test:run-test",
        },
        egress: noopEgress,
        source: createLocalSource("local:test:run-test"),
        sandbox: noopSandbox,
      },
    );

    expect(
      Object.keys(tools).filter((name) => name.startsWith("slack")),
    ).toEqual([]);
    expect(tools).not.toHaveProperty("attachFile");
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
