import { describe, expect, it } from "vitest";
import { normalizeSessionSource, parseSessionSource } from "@/chat/source";

describe("session source", () => {
  it("parses canonical serialized sources", () => {
    expect(
      parseSessionSource({
        platform: "slack",
        visibility: "public",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1700000000.000100",
      }),
    ).toEqual({
      platform: "slack",
      visibility: "public",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.000100",
    });
  });

  it("normalizes slack sources to the session-stable thread anchor", () => {
    expect(
      normalizeSessionSource({
        platform: "slack",
        visibility: "private",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1700000000.000100",
        messageTs: "1700000000.000200",
      }),
    ).toEqual({
      platform: "slack",
      visibility: "private",
      teamId: "T123",
      channelId: "C123",
      threadTs: "1700000000.000100",
    });
  });

  it("keeps channel-level slack sources without inventing a thread anchor", () => {
    expect(
      normalizeSessionSource({
        platform: "slack",
        visibility: "public",
        teamId: "T123",
        channelId: "C123",
        messageTs: "1700000000.000200",
      }),
    ).toEqual({
      platform: "slack",
      visibility: "public",
      teamId: "T123",
      channelId: "C123",
    });
    expect(
      parseSessionSource({
        platform: "slack",
        visibility: "public",
        teamId: "T123",
        channelId: "C123",
        messageTs: "1700000000.000200",
      }),
    ).toEqual({
      platform: "slack",
      visibility: "public",
      teamId: "T123",
      channelId: "C123",
    });
  });

  it("normalizes local sources", () => {
    expect(
      normalizeSessionSource({
        platform: "local",
        visibility: "private",
        conversationId: "local:abc123:demo",
      }),
    ).toEqual({
      platform: "local",
      visibility: "private",
      conversationId: "local:abc123:demo",
    });
  });
});
