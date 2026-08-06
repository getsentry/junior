import { describe, expect, it } from "vitest";
import {
  createSlackSource,
  sourceSchema,
} from "@sentry/junior-plugin-api";

describe("plugin source helpers", () => {
  it("accepts Slack source visibility from the runtime boundary", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "public",
      }),
    ).toMatchObject({ visibility: "public" });
    // Modern Slack private channels also use C-prefixed ids.
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
  });

  it("constructs private Slack sources from caller-provided visibility", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "G123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "D123",
        visibility: "private",
      }),
    ).toMatchObject({ visibility: "private" });
  });

  it("upgrades pre-#1183 persisted source.type values on read", () => {
    expect(
      sourceSchema.parse({
        platform: "slack",
        type: "pub",
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
    expect(
      sourceSchema.parse({
        platform: "slack",
        type: "priv",
        teamId: "T123",
        channelId: "D123",
        messageTs: "1700000000.000200",
      }),
    ).toEqual({
      platform: "slack",
      visibility: "private",
      teamId: "T123",
      channelId: "D123",
      messageTs: "1700000000.000200",
    });
    expect(
      sourceSchema.parse({
        platform: "local",
        type: "priv",
        conversationId: "local:abc123:demo",
      }),
    ).toEqual({
      platform: "local",
      visibility: "private",
      conversationId: "local:abc123:demo",
    });
  });

  it("keeps canonical visibility when both legacy and current fields exist", () => {
    expect(
      sourceSchema.parse({
        platform: "slack",
        type: "pub",
        visibility: "private",
        teamId: "T123",
        channelId: "C123",
      }),
    ).toEqual({
      platform: "slack",
      visibility: "private",
      teamId: "T123",
      channelId: "C123",
    });
  });
});
