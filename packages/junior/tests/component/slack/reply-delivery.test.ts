import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendSlackReply } from "@/chat/slack/reply";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

describe("sendSlackReply", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
    resetSlackApiMockState();
  });

  afterEach(() => {
    resetSlackApiMockState();
  });

  it("posts text with compact attribution in the conversation footer", async () => {
    const ts = await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      replyAttribution: {
        label: "Scheduled task",
        detail: "Weekly",
      },
      text: "hello",
      threadTs: "1700000000.000100",
    });

    expect(typeof ts).toBe("string");
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.000100",
          text: "hello\n\nScheduled task · Weekly",
          blocks: [
            {
              type: "markdown",
              text: "hello",
            },
            {
              type: "context",
              elements: [
                {
                  type: "plain_text",
                  text: "Scheduled task · Weekly",
                },
                {
                  type: "mrkdwn",
                  text: "*ID:* slack:C123:1700000000.000100",
                },
              ],
            },
          ],
        }),
      }),
    ]);
  });

  it("escapes attribution in mrkdwn fallback text", async () => {
    await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      replyAttribution: {
        label: "Scheduled <@U123>",
        detail: "Weekly & <https://example.com>",
      },
      text: "hello",
      threadTs: "1700000000.000100",
    });

    expect(
      getCapturedSlackApiCalls("chat.postMessage")[0]?.params,
    ).toMatchObject({
      text: "hello\n\nScheduled &lt;@U123&gt; · Weekly &amp; &lt;https://example.com&gt;",
      blocks: [
        {
          type: "markdown",
          text: "hello",
        },
        {
          type: "context",
          elements: expect.arrayContaining([
            {
              type: "plain_text",
              text: "Scheduled <@U123> · Weekly & <https://example.com>",
            },
          ]),
        },
      ],
    });
  });

  it("does not post empty text", async () => {
    await expect(
      sendSlackReply({
        channelId: "C123",
        conversationId: "slack:C123:1700000000.000100",
        text: "   ",
        threadTs: "1700000000.000100",
      }),
    ).resolves.toBeUndefined();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });
});
