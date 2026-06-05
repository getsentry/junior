import { beforeEach, describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { setAgentPlugins } from "@/chat/plugins/agent-hooks";
import {
  addReactionToMessage,
  postSlackEphemeralMessage,
  postSlackMessage,
  uploadFilesToThread,
} from "@/chat/slack/outbound";
import {
  filesCompleteUploadOk,
  filesGetUploadUrlOk,
} from "../../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";

describe("Slack contract: outbound normalization", () => {
  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN =
      process.env.SLACK_BOT_TOKEN ?? "xoxb-test-token";
    setAgentPlugins([]);
    resetSlackApiMockState();
  });

  it("normalizes adapter-scoped ids before chat.postMessage", async () => {
    await postSlackMessage({
      channelId: "slack:C123",
      text: "hello",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "hello",
        }),
      }),
    ]);
  });

  it("passes block payloads with a top-level fallback text", async () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
      thinkingLevel: "low",
    });

    await postSlackMessage({
      channelId: "slack:C123",
      text: "hello",
      blocks: buildSlackReplyBlocks("hello", footer),
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
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
                {
                  type: "mrkdwn",
                  text: "*Thinking:* low",
                },
              ],
            },
          ],
        }),
      }),
    ]);
  });

  it("lets trusted plugins replace the footer conversation link", async () => {
    const previous = setAgentPlugins([
      defineJuniorPlugin({
        name: "dashboard",
        manifest: {
          name: "dashboard",
          description: "Dashboard",
        },
        hooks: {
          slackConversationLink(ctx) {
            return {
              url: `https://junior.example.com/conversations/${encodeURIComponent(ctx.conversationId)}`,
            };
          },
        },
      }),
    ]);
    try {
      const footer = buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
      });

      await postSlackMessage({
        channelId: "slack:C123",
        text: "hello",
        blocks: buildSlackReplyBlocks("hello", footer),
      });

      expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
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
                    text: "*ID:* <https://junior.example.com/conversations/slack%3AC123%3A1700000000.000100|slack:C123:1700000000.000100>",
                  },
                ],
              },
            ],
          }),
        }),
      ]);
    } finally {
      setAgentPlugins(previous);
    }
  });

  it("normalizes adapter-scoped ids before file upload completion", async () => {
    queueSlackApiResponse("files.getUploadURLExternal", {
      body: filesGetUploadUrlOk({
        fileId: "F_TEST_1",
        uploadUrl: "https://files.slack.com/upload/v1/F_TEST_1",
      }),
    });
    queueSlackApiResponse("files.completeUploadExternal", {
      body: filesCompleteUploadOk({
        files: [{ id: "F_TEST_1" }],
      }),
    });

    await uploadFilesToThread({
      channelId: "slack:C123",
      threadTs: "1700000000.000100",
      files: [{ data: Buffer.from("hello"), filename: "hello.txt" }],
    });

    expect(getCapturedSlackApiCalls("files.completeUploadExternal")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel_id: "C123",
          thread_ts: "1700000000.000100",
        }),
      }),
    ]);
  });

  it("normalizes adapter-scoped ids before reactions.add", async () => {
    await addReactionToMessage({
      channelId: "slack:C123",
      timestamp: "1700000000.000100",
      emoji: ":wave:",
    });

    expect(getCapturedSlackApiCalls("reactions.add")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          timestamp: "1700000000.000100",
          name: "wave",
        }),
      }),
    ]);
  });

  it("rejects synthetic unknown users before chat.postEphemeral", async () => {
    await expect(
      postSlackEphemeralMessage({
        channelId: "slack:C123",
        userId: "unknown",
        text: "hello",
      }),
    ).rejects.toThrow("Slack ephemeral message posting requires a user ID");

    expect(getCapturedSlackApiCalls("chat.postEphemeral")).toEqual([]);
  });
});
