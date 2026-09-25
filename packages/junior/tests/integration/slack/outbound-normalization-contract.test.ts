import { beforeEach, describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { registerLogRecordSink, type EmittedLogRecord } from "@/chat/logging";
import type { SlackEntity } from "@/chat/slack/work-object";
import {
  buildSlackReplyBlocks,
  buildSlackReplyFooter,
} from "@/chat/slack/footer";
import { setPlugins } from "@/chat/plugins/agent-hooks";
import {
  addReactionToMessage,
  postSlackEphemeralMessage,
  postSlackMessage,
  uploadFilesToThread,
} from "@/chat/slack/outbound";
import { parseSlackMessageTs } from "@/chat/slack/timestamp";
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
    setPlugins([]);
    resetSlackApiMockState();
  });

  it("normalizes adapter-scoped ids and disables unfurls before chat.postMessage", async () => {
    await postSlackMessage({
      channelId: "slack:C123",
      text: "hello",
    });

    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "hello",
          unfurl_links: "false",
          unfurl_media: "false",
        }),
      }),
    ]);
  });

  it.each([false, true])(
    "records safe delivery diagnostics with entities=%s",
    async (includeEntities) => {
      const entities: SlackEntity[] = includeEntities
        ? [
            {
              entity_type: "slack#/entities/item",
              external_ref: { type: "annotation", id: "private-reference" },
              url: "https://private.example/pull/1",
              entity_payload: {
                attributes: { title: { text: "private-title" } },
              },
            },
          ]
        : [];
      queueSlackApiResponse("chat.postMessage", {
        body: {
          ok: true,
          ts: "1700000000.000200",
          response_metadata: { warnings: ["missing_charset"] },
          message: { metadata: { entities } },
        },
      });
      const records: EmittedLogRecord[] = [];
      const unregister = registerLogRecordSink((record) => {
        if (record.eventName.startsWith("slack.work_object.post."))
          records.push(record);
      });
      try {
        await postSlackMessage({
          channelId: "C123",
          threadTs: "1700000000.000100",
          text: "private-message",
          entities,
        });
      } finally {
        unregister();
      }
      expect(records.map((record) => record.eventName)).toEqual([
        "slack.work_object.post.started",
        "slack.work_object.post.accepted",
      ]);
      expect(records[0]?.attributes).toMatchObject({
        "app.slack.channel_id": "C123",
        "app.slack.thread_ts": "1700000000.000100",
        "app.slack.work_object.count": entities.length,
        "app.slack.work_object.metadata_bytes": includeEntities
          ? Buffer.byteLength(JSON.stringify({ entities }))
          : 0,
      });
      expect(
        records[0]?.attributes["app.slack.work_object.entity_types"],
      ).toEqual(includeEntities ? ["slack#/entities/item"] : undefined);
      expect(
        records[0]?.attributes["app.slack.work_object.reference_types"],
      ).toEqual(includeEntities ? ["annotation"] : undefined);
      expect(records[1]?.attributes).toMatchObject({
        "messaging.message.id": "1700000000.000200",
        "app.slack.warning_count": 1,
        "app.slack.diagnostic_codes": ["missing_charset"],
        "app.slack.work_object.response_entity_count": entities.length,
      });
      expect(JSON.stringify(records)).not.toContain("private-");
      expect(JSON.stringify(records)).not.toContain("private.example");
    },
  );

  it("rejects Task fields on Item entities before chat.postMessage", async () => {
    await expect(
      postSlackMessage({
        channelId: "C123",
        text: "The object is ready.",
        entities: [
          // @ts-expect-error Item entities must use custom_fields, not Task fields.
          {
            entity_type: "slack#/entities/item",
            external_ref: { id: "1" },
            url: "https://example.com/pull/1",
            entity_payload: {
              attributes: { title: { text: "Fix the parser" } },
              fields: { status: { value: "draft" } },
            },
          },
        ],
      }),
    ).rejects.toThrow(/fields/);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });

  it("passes block payloads with a top-level fallback text", async () => {
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
              ],
            },
          ],
        }),
      }),
    ]);
  });

  it("lets plugins replace the footer conversation link", async () => {
    const previous = setPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "dashboard",
          displayName: "Dashboard",
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
      setPlugins(previous);
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
    const timestamp = parseSlackMessageTs("1700000000.000100");
    if (!timestamp) {
      throw new Error("Test message timestamp must be a valid Slack ts");
    }

    await addReactionToMessage({
      channelId: "slack:C123",
      timestamp,
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
