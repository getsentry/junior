import { describe, expect, it } from "vitest";
import { createTools } from "@/chat/tools";
import { resolveChannelCapabilities } from "@/chat/tools/channel-capabilities";

const noopSandbox = {} as any;

function ctx(channelId?: string) {
  return {
    channelId,
    channelCapabilities: resolveChannelCapabilities(channelId),
    sandbox: noopSandbox,
  };
}

describe("Slack tool registration", () => {
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

  it("does not register canvas create when channel context is unavailable", () => {
    const tools = createTools([], {}, ctx());

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).not.toHaveProperty("slackMessageAddReaction");
  });
});
