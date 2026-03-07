import { describe, expect, it } from "vitest";
import { createTools } from "@/chat/tools";

const noopSandbox = {} as any;

describe("Slack tool registration", () => {
  it("does not register channel-scope tools in DM context", () => {
    const tools = createTools([], {}, { channelId: "D12345", sandbox: noopSandbox });

    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("registers channel-scope tools in shared channel context", () => {
    const tools = createTools([], {}, { channelId: "C12345", sandbox: noopSandbox });

    expect(tools).toHaveProperty("slackChannelPostMessage");
    expect(tools).toHaveProperty("slackChannelListMessages");
    expect(tools).toHaveProperty("slackMessageAddReaction");
    expect(tools).toHaveProperty("slackCanvasCreate");
  });

  it("does not register canvas create when channel context is unavailable", () => {
    const tools = createTools([], {}, { sandbox: noopSandbox });

    expect(tools).not.toHaveProperty("slackCanvasCreate");
    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackChannelListMessages");
    expect(tools).not.toHaveProperty("slackMessageAddReaction");
  });
});
