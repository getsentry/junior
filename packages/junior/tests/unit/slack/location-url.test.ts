import { describe, expect, it } from "vitest";
import { buildSlackLocationUrl } from "@/chat/slack/location-url";

describe("buildSlackLocationUrl", () => {
  it("builds a direct archive thread url from domain and thread coordinates", () => {
    expect(
      buildSlackLocationUrl({
        channelId: "C07P2KGJGG0",
        teamDomain: "sentry",
        threadTs: "1700000000.000100",
      }),
    ).toBe(
      "https://sentry.slack.com/archives/C07P2KGJGG0/p1700000000000100?thread_ts=1700000000.000100&cid=C07P2KGJGG0",
    );
  });

  it("pads short fractional timestamps to six digits", () => {
    expect(
      buildSlackLocationUrl({
        channelId: "C123",
        teamDomain: "example",
        threadTs: "1700000000.1",
      }),
    ).toBe(
      "https://example.slack.com/archives/C123/p1700000000100000?thread_ts=1700000000.1&cid=C123",
    );
  });

  it("returns undefined for invalid coordinates", () => {
    expect(
      buildSlackLocationUrl({
        channelId: "not-a-channel",
        teamDomain: "sentry",
        threadTs: "1700000000.000100",
      }),
    ).toBeUndefined();
    expect(
      buildSlackLocationUrl({
        channelId: "C123",
        teamDomain: "bad domain",
        threadTs: "1700000000.000100",
      }),
    ).toBeUndefined();
    expect(
      buildSlackLocationUrl({
        channelId: "C123",
        teamDomain: "sentry",
        threadTs: "not-a-ts",
      }),
    ).toBeUndefined();
  });
});
