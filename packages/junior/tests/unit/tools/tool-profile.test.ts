import { describe, expect, it } from "vitest";
import { createTools } from "@/chat/tools";
import type { ToolRuntimeContext } from "@/chat/tools/types";

function context(
  toolProfile: ToolRuntimeContext["toolProfile"],
): ToolRuntimeContext {
  return {
    channelId: "C123",
    channelCapabilities: {
      canCreateCanvas: true,
      canPostToChannel: true,
      canAddReactions: true,
    },
    toolProfile,
    sandbox: {} as ToolRuntimeContext["sandbox"],
  };
}

describe("tool profiles", () => {
  it("registers Slack tools for the slack profile", () => {
    const tools = createTools([], {}, context("slack"));
    expect(tools).toHaveProperty("slackCanvasRead");
    expect(tools).toHaveProperty("slackCanvasUpdate");
    expect(tools).toHaveProperty("slackThreadRead");
    expect(tools).toHaveProperty("slackUserLookup");
    expect(tools).toHaveProperty("slackMessageAddReaction");
  });

  it("excludes Slack-only tools for the github-comment profile", () => {
    const tools = createTools([], {}, context("github-comment"));
    expect(tools).not.toHaveProperty("slackCanvasRead");
    expect(tools).not.toHaveProperty("slackCanvasUpdate");
    expect(tools).not.toHaveProperty("slackThreadRead");
    expect(tools).not.toHaveProperty("slackUserLookup");
    expect(tools).not.toHaveProperty("slackListCreate");
    expect(tools).not.toHaveProperty("slackChannelPostMessage");
    expect(tools).not.toHaveProperty("slackMessageAddReaction");
  });
});
