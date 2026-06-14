import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDb } from "@sentry/junior-plugin-api";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { schedulerPlugin } from "@sentry/junior-scheduler";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import * as pluginDbModule from "@/chat/plugins/db";
const noopSandbox = {} as any;

function ctx(): Extract<ToolRuntimeContext, { source: { platform: "local" } }>;
function ctx(
  channelId: string,
): Extract<ToolRuntimeContext, { source: { platform: "slack" } }>;
function ctx(channelId?: string): ToolRuntimeContext {
  if (!channelId) {
    return {
      destination: {
        platform: "local" as const,
        conversationId: "local:test:tool-registration",
      },
      source: {
        platform: "local" as const,
        conversationId: "local:test:tool-registration",
      },
      sandbox: noopSandbox,
    };
  }

  return {
    destination: {
      platform: "slack" as const,
      teamId: "T123",
      channelId,
    },
    source: {
      platform: "slack" as const,
      teamId: "T123",
      channelId,
    },
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

  it("does not register channel-scope tools in DM context", () => {
    const tools = createTools([], {}, ctx("D12345"));

    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("registers channel-scope tools in shared channel context", () => {
    const tools = createTools([], {}, ctx("C12345"));

    expect(tools).toHaveProperty("slackChannelPostMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
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

    expect(tools).toHaveProperty("slackChannelPostMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("registers schedule tools only with complete Slack turn context", () => {
    vi.spyOn(pluginDbModule, "getPluginDbForRegistration").mockReturnValue(
      {} as PluginDb,
    );
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
        requester: {
          platform: "slack",
          teamId: "T123",
          userId: "U123",
        },
      },
    );

    expect(incomplete).not.toHaveProperty("slackScheduleCreateTask");
    expect(complete).toHaveProperty("slackScheduleCreateTask");
    expect(complete).toHaveProperty("slackScheduleListTasks");
    expect(complete).toHaveProperty("slackScheduleUpdateTask");
    expect(complete).toHaveProperty("slackScheduleDeleteTask");
    expect(complete).toHaveProperty("slackScheduleRunTaskNow");
  });

  it("does not register schedule tools without a requester", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
      },
    );

    expect(tools).not.toHaveProperty("slackScheduleCreateTask");
    expect(tools).not.toHaveProperty("slackScheduleListTasks");
    expect(tools).not.toHaveProperty("slackScheduleUpdateTask");
    expect(tools).not.toHaveProperty("slackScheduleDeleteTask");
    expect(tools).not.toHaveProperty("slackScheduleRunTaskNow");
  });

  it("does not register canvas create when channel context is unavailable", () => {
    const tools = createTools([], {}, ctx());

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackCanvasRead");
    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).not.toHaveProperty("slackMessageAddReaction");
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
        source: {
          platform: "local",
          conversationId: "local:test:run-test",
        },
        sandbox: noopSandbox,
      },
    );

    expect(
      Object.keys(tools).filter((name) => name.startsWith("slack")),
    ).toEqual([]);
  });
});
