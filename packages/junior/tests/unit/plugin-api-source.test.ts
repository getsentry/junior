import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";

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
});
