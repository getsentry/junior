import { describe, expect, it } from "vitest";
import { normalizeSessionSource, parseSessionSource } from "@/chat/source";

describe("session source", () => {
  it("parses canonical serialized sources", () => {
    expect(
      parseSessionSource({
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1700000000.000100",
      }),
    ).toEqual({
      platform: "slack",
      type: "pub",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.000100",
    });
  });

  it("normalizes slack sources to the session-stable thread anchor", () => {
    expect(
      normalizeSessionSource({
        platform: "slack",
        type: "priv",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1700000000.000100",
        messageTs: "1700000000.000200",
      }),
    ).toEqual({
      platform: "slack",
      type: "priv",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.000100",
    });
  });

  it("rejects slack sources without a thread anchor", () => {
    expect(
      normalizeSessionSource({
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C123",
        messageTs: "1700000000.000200",
      }),
    ).toBeUndefined();
    expect(
      parseSessionSource({
        platform: "slack",
        type: "pub",
        teamId: "T123",
        channelId: "C123",
        messageTs: "1700000000.000200",
      }),
    ).toBeUndefined();
  });

  it("normalizes local sources", () => {
    expect(
      normalizeSessionSource({
        platform: "local",
        type: "priv",
        conversationId: "local:abc123:demo",
      }),
    ).toEqual({
      platform: "local",
      type: "priv",
      conversationId: "local:abc123:demo",
    });
  });
});
