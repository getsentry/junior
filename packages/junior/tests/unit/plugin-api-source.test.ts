import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";

describe("plugin source helpers", () => {
  it("classifies Slack source visibility from the event channel_type signal", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        channelType: "channel",
      }),
    ).toMatchObject({ type: "pub" });
    // Modern Slack private channels also use C-prefixed ids.
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        channelType: "group",
      }),
    ).toMatchObject({ type: "priv" });
  });

  it("fails closed to private when no channel_type signal exists", () => {
    expect(
      createSlackSource({ teamId: "T123", channelId: "C123" }),
    ).toMatchObject({ type: "priv" });
    expect(
      createSlackSource({ teamId: "T123", channelId: "G123" }),
    ).toMatchObject({ type: "priv" });
    expect(
      createSlackSource({ teamId: "T123", channelId: "D123" }),
    ).toMatchObject({ type: "priv" });
  });
});
