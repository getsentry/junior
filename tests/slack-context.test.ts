import { describe, expect, it } from "vitest";
import { resolveSlackChannelIdFromMessage, resolveSlackChannelIdFromThreadId } from "@/chat/slack-context";

describe("slack context", () => {
  it("prefers message.channelId when available", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        channelId: "C123",
        raw: { channel: "C456" },
        threadId: "slack:C789:1700000000.100"
      })
    ).toBe("C123");
  });

  it("falls back to raw.channel when message.channelId is absent", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        raw: { channel: "C456" },
        threadId: "slack:C789:1700000000.100"
      })
    ).toBe("C456");
  });

  it("falls back to decoding slack threadId when channel fields are absent", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        threadId: "slack:C789:1700000000.100"
      })
    ).toBe("C789");
  });

  it("returns undefined for non-slack thread ids", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        threadId: "thread-123"
      })
    ).toBeUndefined();
  });

  it("decodes slack channel from thread id directly", () => {
    expect(resolveSlackChannelIdFromThreadId("slack:C111:1700000000.900")).toBe("C111");
  });

  it("returns undefined for malformed thread ids", () => {
    expect(resolveSlackChannelIdFromThreadId("slack::1700000000.900")).toBeUndefined();
    expect(resolveSlackChannelIdFromThreadId("slack:C111")).toBeUndefined();
    expect(resolveSlackChannelIdFromThreadId("not-slack:C111:1700000000.900")).toBeUndefined();
  });
});
