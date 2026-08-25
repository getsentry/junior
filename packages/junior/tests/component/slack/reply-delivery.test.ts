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
    const messageTs = await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      replyAttribution: {
        label: "Scheduled task",
        detail: "Weekly",
      },
      text: "hello",
      threadTs: "1700000000.000100",
    });

    expect(messageTs).toHaveLength(1);
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

  it("returns every posted message timestamp for chunked replies", async () => {
    const messageTs = await sendSlackReply({
      channelId: "C123",
      conversationId: "agent-dispatch:dispatch-1",
      text: "a".repeat(4_500),
    });

    expect(messageTs).toHaveLength(3);
    expect(messageTs.every(Boolean)).toBe(true);

    const posts = getCapturedSlackApiCalls("chat.postMessage");
    expect(posts).toHaveLength(3);
    expect(posts[0]?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
      }),
    );
    expect(posts[0]?.params).not.toHaveProperty("thread_ts");
    // Overflow without an inbound thread roots under the first posted chunk.
    expect(posts[1]?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
        thread_ts: messageTs[0],
      }),
    );
    expect(posts[2]?.params).toEqual(
      expect.objectContaining({
        channel: "C123",
        thread_ts: messageTs[0],
      }),
    );
  });

  it("keeps an inbound thread_ts for every overflow chunk", async () => {
    const messageTs = await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      text: "a".repeat(4_500),
      threadTs: "1700000000.000100",
    });

    expect(messageTs.length).toBeGreaterThan(1);
    for (const post of getCapturedSlackApiCalls("chat.postMessage")) {
      expect(post.params).toEqual(
        expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.000100",
        }),
      );
    }
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
    ).resolves.toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });
});
