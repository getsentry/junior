import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDb } from "@sentry/junior-plugin-api";
import { createTools } from "@/chat/tools";
import { schedulerPlugin } from "@sentry/junior-scheduler";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import * as pluginDbModule from "@/chat/plugins/db";
import {
  createTestToolRuntimeContext,
  createUnavailableSandbox,
} from "../../fixtures/tool-runtime";

function ctx(channelId?: string) {
  return createTestToolRuntimeContext({
    channelId,
  });
}

function slackCtxWithoutRequester(channelId: string): ToolRuntimeContext {
  return {
    destination: {
      platform: "slack",
      teamId: "T123",
      channelId,
    },
    source: {
      platform: "slack",
      teamId: "T123",
      channelId,
    },
    sandbox: createUnavailableSandbox(),
  };
}

function slackCtxWithoutDestination(channelId: string): ToolRuntimeContext {
  return {
    requester: {
      platform: "slack",
      teamId: "T123",
      userId: "U123",
    },
    source: {
      platform: "slack",
      teamId: "T123",
      channelId,
    },
    sandbox: createUnavailableSandbox(),
  };
}

describe("Slack tool registration", () => {
  beforeEach(() => {
    setPlugins([schedulerPlugin()]);
    vi.spyOn(pluginDbModule, "getPluginDbForRegistration").mockReturnValue(
      {} as PluginDb,
    );
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
    const incomplete = createTools([], {}, slackCtxWithoutRequester("C12345"));
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

  it("does not register destination-scoped Slack tools without an output destination", () => {
    const tools = createTools([], {}, slackCtxWithoutDestination("C12345"));

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
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
        sandbox: createUnavailableSandbox(),
      },
    );

    expect(
      Object.keys(tools).filter((name) => name.startsWith("slack")),
    ).toEqual([]);
  });
});
