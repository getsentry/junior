import { describe, expect, it } from "vitest";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";

describe("buildSlackReplyFooter", () => {
  it("returns compact footer items for available diagnostics", () => {
    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
        durationMs: 842,
        thinkingLevel: "medium",
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
          value: "1.2k",
        },
        {
          label: "Time",
          value: "842ms",
        },
        {
          label: "Thinking",
          value: "medium",
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
          value: "1.2k",
        },
      ],
    });
  });

  describe("formatSlackTokenCount", () => {
    it("shows raw number for values under 1000", () => {
      expect(buildSlackReplyFooter({ usage: { totalTokens: 542 } })).toEqual({
        items: [{ label: "Tokens", value: "542" }],
      });
    });

    it("shows k suffix for thousands", () => {
      expect(buildSlackReplyFooter({ usage: { totalTokens: 54300 } })).toEqual({
        items: [{ label: "Tokens", value: "54.3k" }],
      });
    });

    it("drops trailing zero in k suffix", () => {
      expect(buildSlackReplyFooter({ usage: { totalTokens: 2000 } })).toEqual({
        items: [{ label: "Tokens", value: "2k" }],
      });
    });

    it("shows m suffix for millions", () => {
      expect(
        buildSlackReplyFooter({ usage: { totalTokens: 1465542 } }),
      ).toEqual({
        items: [{ label: "Tokens", value: "1.47m" }],
      });
    });

    it("drops trailing zeros in m suffix", () => {
      expect(
        buildSlackReplyFooter({ usage: { totalTokens: 2000000 } }),
      ).toEqual({
        items: [{ label: "Tokens", value: "2m" }],
      });
    });
  });

  describe("formatSlackDuration", () => {
    it("shows ms for sub-second durations", () => {
      expect(buildSlackReplyFooter({ durationMs: 450 })).toEqual({
        items: [{ label: "Time", value: "450ms" }],
      });
    });

    it("shows decimal seconds for 1-9s", () => {
      expect(buildSlackReplyFooter({ durationMs: 1250 })).toEqual({
        items: [{ label: "Time", value: "1.3s" }],
      });
    });

    it("shows whole seconds for 10-59s", () => {
      expect(buildSlackReplyFooter({ durationMs: 42000 })).toEqual({
        items: [{ label: "Time", value: "42s" }],
      });
    });

    it("shows minutes and seconds for 60s+", () => {
      expect(buildSlackReplyFooter({ durationMs: 417000 })).toEqual({
        items: [{ label: "Time", value: "6m57s" }],
      });
    });

    it("shows only minutes when seconds is zero", () => {
      expect(buildSlackReplyFooter({ durationMs: 120000 })).toEqual({
        items: [{ label: "Time", value: "2m" }],
      });
    });
  });
});

describe("buildSlackReplyBlocks", () => {
  it("renders the reply body as a markdown block plus a context footer", () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
      durationMs: 1250,
      thinkingLevel: "high",
      usage: {
        inputTokens: 400,
        outputTokens: 250,
      },
    });

    expect(buildSlackReplyBlocks("Hello world", footer)).toEqual([
      {
        type: "markdown",
        text: "Hello world",
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "*ID:* slack:C123:1700000000.000100",
          },
          {
            type: "mrkdwn",
            text: "*Tokens:* 650",
          },
          {
            type: "mrkdwn",
            text: "*Time:* 1.3s",
          },
          {
            type: "mrkdwn",
            text: "*Thinking:* high",
          },
        ],
      },
    ]);
  });

  it("renders a markdown block without footer when footer is undefined", () => {
    expect(buildSlackReplyBlocks("Hello world", undefined)).toEqual([
      {
        type: "markdown",
        text: "Hello world",
      },
    ]);
  });

  it("does not emit blocks when the reply has no visible text", () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
    });

    expect(buildSlackReplyBlocks("   ", footer)).toBeUndefined();
  });
});
