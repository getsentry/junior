import { describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";

describe("plugin source helpers", () => {
  it("infers Slack source visibility from channel ids when event type is unavailable", () => {
    expect(
      createSlackSource({ teamId: "T123", channelId: "C123" }),
    ).toMatchObject({ type: "pub" });
    expect(
      createSlackSource({ teamId: "T123", channelId: "G123" }),
    ).toMatchObject({ type: "priv" });
    expect(
      createSlackSource({ teamId: "T123", channelId: "D123" }),
    ).toMatchObject({ type: "priv" });
  });
});
