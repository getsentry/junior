import { describe, expect, it } from "vitest";
import { buildSlackReplyFooter } from "@/chat/slack/footer";

describe("buildSlackReplyFooter", () => {
  it("returns compact footer items for available diagnostics", () => {
    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
        durationMs: 842,
        traceId: "0123456789abcdef0123456789abcdef",
        usage: {
          totalTokens: 1234,
        },
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          value: "slack:C123:1700000000.000100",
        },
        {
          label: "Tokens",
          value: "1,234",
        },
        {
          label: "Time",
          value: "842ms",
        },
        {
          label: "Trace",
          value: "0123456789abcdef0123456789abcdef",
        },
      ],
    });
  });

  it("omits the footer when no items are available", () => {
    expect(buildSlackReplyFooter({})).toBeUndefined();
  });

  it("sums individual token counters when rendering the Tokens item", () => {
    expect(
      buildSlackReplyFooter({
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 200,
          cacheCreationTokens: 10,
          totalTokens: 9999,
        },
      }),
    ).toEqual({
      items: [
        {
          label: "Tokens",
          value: "360",
        },
      ],
    });
  });

  it("falls back to totalTokens when no component counters are reported", () => {
    expect(
      buildSlackReplyFooter({
        usage: { totalTokens: 1234 },
      }),
    ).toEqual({
      items: [
        {
          label: "Tokens",
          value: "1,234",
        },
      ],
    });
  });
});
