import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";

describe("plugin source helpers", () => {
  it("accepts Slack source visibility from the runtime boundary", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        type: "pub",
      }),
    ).toMatchObject({ type: "pub" });
    // Modern Slack private channels also use C-prefixed ids.
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        type: "priv",
      }),
    ).toMatchObject({ type: "priv" });
  });

  it("constructs private Slack sources from caller-provided visibility", () => {
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "C123",
        type: "priv",
      }),
    ).toMatchObject({ type: "priv" });
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "G123",
        type: "priv",
      }),
    ).toMatchObject({ type: "priv" });
    expect(
      createSlackSource({
        teamId: "T123",
        channelId: "D123",
        type: "priv",
      }),
    ).toMatchObject({ type: "priv" });
  });
});
