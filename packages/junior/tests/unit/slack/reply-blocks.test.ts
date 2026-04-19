import { describe, expect, it } from "vitest";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { buildSlackReplyBlocks } from "@/chat/slack/reply-blocks";

describe("buildSlackReplyBlocks", () => {
  it("wraps plain replies in an expanded section block", () => {
    expect(buildSlackReplyBlocks("Hello world", undefined)).toEqual([
      {
        type: "section",
        expand: true,
        text: {
          type: "mrkdwn",
          text: "Hello world",
        },
      },
    ]);
  });

  it("renders a native table block when the original reply contained a table", () => {
    expect(
      buildSlackReplyBlocks(
        [
          "```",
          "Service | Docs",
          "------- | -------------------------------",
          "Slack   | <https://docs.slack.dev/|Slack>",
          "```",
        ].join("\n"),
        undefined,
        {
          richSourceText: [
            "| Service | Docs |",
            "| --- | --- |",
            "| Slack | [Slack](https://docs.slack.dev/) |",
          ].join("\n"),
        },
      ),
    ).toEqual([
      {
        type: "table",
        rows: [
          [
            { type: "raw_text", text: "Service" },
            { type: "raw_text", text: "Docs" },
          ],
          [
            { type: "raw_text", text: "Slack" },
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    {
                      type: "link",
                      url: "https://docs.slack.dev/",
                      text: "Slack",
                    },
                  ],
                },
              ],
            },
          ],
        ],
      },
    ]);
  });

  it("renders the reply body plus a Slack context footer block", () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
      durationMs: 1250,
      traceId: "trace_123",
      usage: {
        inputTokens: 400,
        outputTokens: 250,
      },
    });

    expect(buildSlackReplyBlocks("Hello world", footer)).toEqual([
      {
        type: "section",
        expand: true,
        text: {
          type: "mrkdwn",
          text: "Hello world",
        },
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
            text: "*Trace:* trace_123",
          },
        ],
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
