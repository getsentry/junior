import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocalSource,
  createSlackSource,
} from "@sentry/junior-plugin-api";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import { schedulerPlugin } from "@sentry/junior-scheduler";
import { setPlugins } from "@/chat/plugins/agent-hooks";
const noopSandbox = {} as any;
const noopEgress = {
  async fetch() {
    return new Response("ok");
  },
};

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
      egress: noopEgress,
      source: createLocalSource("local:test:tool-registration"),
      sandbox: noopSandbox,
    };
  }

  return {
    destination: {
      platform: "slack" as const,
      teamId: "T123",
      channelId,
    },
    source: createSlackSource({
      teamId: "T123",
      channelId,
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

  it("does not register standalone channel posting outside interactive Slack turns", () => {
    const tools = createTools(
      [],
      {},
      {
        ...ctx("C12345"),
        surface: "api",
      },
    );

    expect(tools).not.toHaveProperty("slackChannelPostMessage");
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

    expect(tools).toHaveProperty("slackChannelPostMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
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
        requester: {
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

  it("does not register schedule tools without a requester", () => {
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
        egress: noopEgress,
        source: createLocalSource("local:test:run-test"),
        sandbox: noopSandbox,
      },
    );

    expect(
      Object.keys(tools).filter((name) => name.startsWith("slack")),
    ).toEqual([]);
  });
});
