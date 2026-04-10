import { describe, expect, it } from "vitest";
import { buildMessageChangedMentionDispatch } from "@/chat/ingress/message-changed";

function messageChangedPayload(
  overrides: {
    botId?: string;
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
      message: {
        type: "message",
        user: "U_USER",
        text: overrides.newText ?? "<@U_BOT> can you check this?",
        ts: "1700000000.500",
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
      messageChangedPayload(),
      "U_BOT",
    );

    expect(dispatch).toEqual({
      event: expect.objectContaining({
        type: "message",
        channel: "C_TEST",
        text: "<@U_BOT> can you check this?",
        thread_ts: "1700000000.500",
        ts: "1700000000.500",
        user: "U_USER",
      }),
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
