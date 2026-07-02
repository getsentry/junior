import { describe, expect, it } from "vitest";
import {
  formatSlackConversationContextLabel,
  formatSlackConversationRedactedLabel,
  formatSlackConversationTypeLabel,
  resolveSlackChannelTypeFromMessage,
  resolveSlackConversationContext,
} from "@/chat/slack/conversation-context";

describe("Slack conversation prompt context", () => {
  it("includes public channel names", () => {
    expect(
      resolveSlackConversationContext({
        channelId: "C123",
        channelName: "engineering",
        channelType: "channel",
      }),
    ).toEqual({
      type: "public_channel",
      name: "#engineering",
      visibility: "public",
    });
  });

  it("includes private conversation names when Slack provides them", () => {
    expect(
      resolveSlackConversationContext({
        channelId: "G123",
        channelName: "private-roadmap",
        channelType: "group",
      }),
    ).toEqual({
      type: "private_channel",
      name: "#private-roadmap",
      visibility: "private",
    });
    expect(
      resolveSlackConversationContext({
        channelId: "G456",
        channelName: "mpdm-alice--bob-1",
        channelType: "mpim",
      }),
    ).toEqual({
      type: "group_dm",
      name: "mpdm-alice--bob-1",
      visibility: "private",
    });
    expect(
      resolveSlackConversationContext({
        channelId: "D123",
        channelName: "alice",
        channelType: "im",
      }),
    ).toEqual({
      type: "direct_message",
      name: "alice",
      visibility: "private",
    });
  });

  it("uses a conservative type when only a G-prefixed ID is known", () => {
    expect(
      resolveSlackConversationContext({
        channelId: "G123",
        channelName: "maybe-private",
      }),
    ).toEqual({
      type: "private_channel_or_group_dm",
      name: "#maybe-private",
      visibility: "private",
    });
  });

  it("classifies a C-prefixed channel private when Slack reports channel_type group", () => {
    expect(
      resolveSlackConversationContext({
        channelId: "C123",
        channelName: "actually-private",
        channelType: "group",
      }),
    ).toMatchObject({ visibility: "private" });
  });

  it("leaves visibility undefined for C-prefixed ids without a signal", () => {
    expect(
      resolveSlackConversationContext({
        channelId: "C123",
        channelName: "maybe-public",
      }),
    ).toEqual({ type: "public_channel", name: "#maybe-public" });
  });

  it("extracts Slack channel type from message-like raw payloads", () => {
    expect(
      resolveSlackChannelTypeFromMessage({
        raw: {
          channel_type: "mpim",
        },
      }),
    ).toBe("mpim");
  });

  it("formats labels from the shared conversation type vocabulary", () => {
    expect(formatSlackConversationTypeLabel("public_channel")).toBe(
      "Public Channel",
    );
    expect(formatSlackConversationTypeLabel("private_channel")).toBe(
      "Private Channel",
    );
    expect(formatSlackConversationTypeLabel("group_dm")).toBe("Group DM");
    expect(formatSlackConversationTypeLabel("direct_message")).toBe(
      "Direct Message",
    );
    expect(
      formatSlackConversationTypeLabel("private_channel_or_group_dm"),
    ).toBe("Private Channel or Group DM");
  });

  it("uses conversation names before falling back to type labels", () => {
    expect(
      formatSlackConversationContextLabel({
        type: "public_channel",
        name: "#engineering",
      }),
    ).toBe("#engineering");
    expect(
      formatSlackConversationContextLabel({
        type: "direct_message",
        name: "alice",
      }),
    ).toBe("alice");
    expect(
      formatSlackConversationContextLabel({
        type: "direct_message",
      }),
    ).toBe("Direct Message");
  });

  it("redacts conversation names for trace and reporting labels", () => {
    expect(
      formatSlackConversationRedactedLabel({
        type: "private_channel",
        name: "#private-roadmap",
      }),
    ).toBe("Private Channel");
    expect(
      formatSlackConversationRedactedLabel({
        type: "public_channel",
        name: "#engineering",
      }),
    ).toBe("Public Channel");
  });
});
