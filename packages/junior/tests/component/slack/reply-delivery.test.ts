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

  it("posts text with a conversation footer on the final chunk", async () => {
    const ts = await sendSlackReply({
      channelId: "C123",
      conversationId: "slack:C123:1700000000.000100",
      text: "hello",
      threadTs: "1700000000.000100",
    });

    expect(typeof ts).toBe("string");
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          thread_ts: "1700000000.000100",
          text: "hello",
          blocks: [
            {
              type: "markdown",
              text: "hello",
            },
            {
              type: "context",
              elements: [
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
