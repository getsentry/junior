import { describe, expect, it } from "vitest";
import {
  parseSlackThreadId,
  resolveSlackChannelIdFromMessage,
} from "@/chat/slack/context";

describe("slack context", () => {
  it("prefers message.channelId when available", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        channelId: "C123",
        raw: { channel: "C456" },
        threadId: "slack:C789:1700000000.100",
      }),
    ).toBe("C123");
  });

  it("falls back to raw.channel when message.channelId is absent", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        raw: { channel: "C456" },
        threadId: "slack:C789:1700000000.100",
      }),
    ).toBe("C456");
  });

  it("does not read Message.threadId, which can be a Conversation id", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        threadId: "slack:C789:1700000000.100",
      }),
    ).toBeUndefined();
  });

  it("trims whitespace from extracted channel ids", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        channelId: " C123 ",
      }),
    ).toBe("C123");
    expect(
      resolveSlackChannelIdFromMessage({
        raw: { channel: " C456 " },
      }),
    ).toBe("C456");
  });
});

describe("parseSlackThreadId", () => {
  it("parses valid slack thread id into channelId and threadTs", () => {
    expect(parseSlackThreadId("slack:C123:1700000000.100")).toEqual({
      channelId: "C123",
      threadTs: "1700000000.100",
    });
  });

  it("trims whitespace around slack thread ids before decoding", () => {
    expect(parseSlackThreadId(" slack:C123:1700000000.100 ")).toEqual({
      channelId: "C123",
      threadTs: "1700000000.100",
    });
    expect(parseSlackThreadId("slack: C123 : 1700000000.100 ")).toEqual({
      channelId: "C123",
      threadTs: "1700000000.100",
    });
  });

  it("returns undefined for empty-part thread ids", () => {
    expect(parseSlackThreadId("slack::1700000000.100")).toBeUndefined();
    expect(parseSlackThreadId("slack:C123:")).toBeUndefined();
    expect(parseSlackThreadId("slack: : ")).toBeUndefined();
  });

  it("returns undefined for malformed thread ids", () => {
    expect(parseSlackThreadId("slack:C123")).toBeUndefined();
    expect(parseSlackThreadId("not-slack:C123:1700000000.100")).toBeUndefined();
    expect(parseSlackThreadId("just-a-string")).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(parseSlackThreadId(undefined)).toBeUndefined();
  });
});
