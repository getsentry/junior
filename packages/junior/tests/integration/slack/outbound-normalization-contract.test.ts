import { beforeEach, describe, expect, it } from "vitest";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import {
  addReactionToMessage,
  postSlackMessage,
  uploadFilesToThread,
} from "@/chat/slack/outbound";
import { buildSlackReplyBlocks } from "@/chat/slack/reply-blocks";
import { postSlackApiReplyPosts } from "@/chat/slack/reply";
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
      traceId: "trace_123",
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
              type: "section",
              expand: true,
              text: {
                type: "mrkdwn",
                text: "hello",
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
                  text: "*Trace:* trace_123",
                },
              ],
            },
          ],
        }),
      }),
    ]);
  });

  it("uses a native table block when raw API reply delivery includes a markdown table source", async () => {
    await postSlackApiReplyPosts({
      channelId: "slack:C123",
      threadTs: "1700000000.000100",
      posts: [
        {
          stage: "thread_reply",
          text: [
            "```",
            "Service | Docs",
            "------- | -------------------------------",
            "Slack   | <https://docs.slack.dev/|Slack>",
            "```",
          ].join("\n"),
          richSourceText: [
            "| Service | Docs |",
            "| --- | --- |",
            "| Slack | [Slack](https://docs.slack.dev/) |",
          ].join("\n"),
        },
      ],
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: [
            "```",
            "Service | Docs",
            "------- | -------------------------------",
            "Slack   | <https://docs.slack.dev/|Slack>",
            "```",
          ].join("\n"),
          blocks: [
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
          ],
        }),
      }),
    ]);
  });

  it("wraps each raw API text chunk in a section block and keeps the footer on the final chunk", async () => {
    const footer = buildSlackReplyFooter({
      conversationId: "slack:C123:1700000000.000100",
    });

    await postSlackApiReplyPosts({
      channelId: "slack:C123",
      threadTs: "1700000000.000100",
      footer,
      posts: [
        {
          stage: "thread_reply",
          text: "first chunk",
        },
        {
          stage: "thread_reply_continuation",
          text: "second chunk",
        },
      ],
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "first chunk",
          blocks: [
            {
              type: "section",
              expand: true,
              text: {
                type: "mrkdwn",
                text: "first chunk",
              },
            },
          ],
        }),
      }),
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "second chunk",
          blocks: [
            {
              type: "section",
              expand: true,
              text: {
                type: "mrkdwn",
                text: "second chunk",
              },
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
});
