import { describe, expect, it } from "vitest";
import {
  createSlackDestination,
  destinationKey,
  parseDestination,
  sameDestination,
} from "@/chat/destination";

describe("destination context", () => {
  it("normalizes external Slack ids only when creating a destination", () => {
    expect(
      createSlackDestination({
        teamId: "T123",
        channelId: "slack:C123:1700000000.000",
      }),
    ).toEqual({
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    });
  });

  it("rejects non-canonical serialized destinations", () => {
    expect(
      parseDestination({
        platform: "slack",
        teamId: "T123",
        channelId: "slack:C123:1700000000.000",
      }),
    ).toBeUndefined();
    expect(
      parseDestination({
        platform: "slack",
        teamId: " T123 ",
        channelId: "C123",
      }),
    ).toBeUndefined();
    expect(
      parseDestination({
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1700000000.000",
      }),
    ).toBeUndefined();
  });

  it("parses canonical serialized destinations without repair", () => {
    expect(
      parseDestination({
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      }),
    ).toEqual({
      platform: "slack",
      teamId: "T123",
      channelId: "C123",
    });
  });

  it("parses local destinations", () => {
    const destination = parseDestination({
      platform: "local",
      conversationId: "local:abc123:demo",
    });

    expect(destination).toEqual({
      platform: "local",
      conversationId: "local:abc123:demo",
    });
    expect(destinationKey(destination!)).toBe("local:abc123:demo");
    expect(
      sameDestination(destination!, {
        platform: "local",
        conversationId: "local:abc123:demo",
      }),
    ).toBe(true);
  });
});
