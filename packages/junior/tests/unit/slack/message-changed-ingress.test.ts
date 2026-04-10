import type { SlackEvent } from "@chat-adapter/slack";
import { describe, expect, it } from "vitest";
import { buildMessageChangedMentionDispatch } from "@/chat/ingress/message-changed";

function messageChangedPayload(
  overrides: {
    botId?: string;
    blocks?: SlackEvent["blocks"];
    editedTs?: string;
    files?: SlackEvent["files"];
    newText?: string;
    prevText?: string;
    threadTs?: string;
  } = {},
) {
  return {
    type: "event_callback",
    team_id: "T_TEST",
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "C_TEST",
      ts: overrides.editedTs ?? "1700000001.000",
      message: {
        type: "message",
        user: "U_USER",
        text: overrides.newText ?? "<@U_BOT> can you check this?",
        ts: "1700000000.500",
        ...(overrides.blocks ? { blocks: overrides.blocks } : {}),
        ...(overrides.editedTs
          ? { edited: { ts: overrides.editedTs, user: "U_USER" } }
          : {}),
        ...(overrides.files ? { files: overrides.files } : {}),
        ...(overrides.threadTs ? { thread_ts: overrides.threadTs } : {}),
        ...(overrides.botId ? { bot_id: overrides.botId } : {}),
      },
      previous_message: {
        text: overrides.prevText ?? "can you check this?",
      },
    },
  };
}

describe("buildMessageChangedMentionDispatch", () => {
  it("returns a dispatchable Slack message when an edit adds a new mention", () => {
    const dispatch = buildMessageChangedMentionDispatch(
      messageChangedPayload({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "link",
                    url: "https://example.com/deploys/123",
                    text: "deploy",
                  },
                ],
              },
            ],
          },
        ],
        editedTs: "1700000001.000",
        files: [
          {
            id: "F_TEST",
            mimetype: "image/png",
            name: "deploy.png",
            url_private:
              "https://files.slack.com/files-pri/T_TEST-F_TEST/deploy.png",
          },
        ],
      }),
      "U_BOT",
    );

    expect(dispatch).toEqual({
      event: expect.objectContaining({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "link",
                    url: "https://example.com/deploys/123",
                    text: "deploy",
                  },
                ],
              },
            ],
          },
        ],
        type: "message",
        channel: "C_TEST",
        files: [
          {
            id: "F_TEST",
            mimetype: "image/png",
            name: "deploy.png",
            url_private:
              "https://files.slack.com/files-pri/T_TEST-F_TEST/deploy.png",
          },
        ],
        text: "<@U_BOT> can you check this?",
        ts: "1700000000.500",
        user: "U_USER",
      }),
      messageId: "1700000000.500:edit:1700000001.000",
      threadId: "slack:C_TEST:1700000000.500",
    });
  });

  it("returns undefined when the edit did not introduce a new mention", () => {
    const dispatch = buildMessageChangedMentionDispatch(
      messageChangedPayload({
        prevText: "<@U_BOT> can you check this?",
      }),
      "U_BOT",
    );

    expect(dispatch).toBeUndefined();
  });

  it("returns undefined for bot-authored edits", () => {
    const dispatch = buildMessageChangedMentionDispatch(
      messageChangedPayload({ botId: "B_BOT" }),
      "U_BOT",
    );

    expect(dispatch).toBeUndefined();
  });
});
