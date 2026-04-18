import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import {
  addReactionToMessage,
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
          link_names: "true",
          mrkdwn: "true",
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
          link_names: "true",
          mrkdwn: "true",
          text: "hello",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: "hello",
                verbatim: false,
              },
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: "*ID:* slack:C123:1700000000.000100",
                  verbatim: false,
                },
                {
                  type: "mrkdwn",
                  text: "*Trace:* trace_123",
                  verbatim: false,
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
