import { describe, expect, it } from "vitest";
import { resolveChannelCapabilities } from "@/chat/slack/tools/channel-capabilities";

describe("resolveChannelCapabilities", () => {
  it.each([
    {
      label: "public channel",
      channelId: "C123",
      expected: {
        canCreateCanvas: true,
        canSendMessage: true,
        canPostToChannel: true,
        canAddReactions: true,
      },
    },
    {
      label: "group channel",
      channelId: "G456",
      expected: {
        canCreateCanvas: true,
        canSendMessage: true,
        canPostToChannel: true,
        canAddReactions: true,
      },
    },
    {
      label: "DM channel",
      channelId: "D789",
      expected: {
        canCreateCanvas: true,
        canSendMessage: true,
        canPostToChannel: false,
        canAddReactions: true,
      },
    },
    {
      label: "undefined channel",
      channelId: undefined,
      expected: {
        canCreateCanvas: false,
        canSendMessage: false,
        canPostToChannel: false,
        canAddReactions: false,
      },
    },
    {
      label: "empty string",
      channelId: "",
      expected: {
        canCreateCanvas: false,
        canSendMessage: false,
        canPostToChannel: false,
        canAddReactions: false,
      },
    },
  ])("$label (channelId=$channelId)", ({ channelId, expected }) => {
    expect(resolveChannelCapabilities(channelId)).toEqual(expected);
  });
});
