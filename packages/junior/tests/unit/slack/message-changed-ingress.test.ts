import { describe, expect, it } from "vitest";
import type { Adapter } from "chat";
import { extractMessageChangedMention } from "@/chat/ingress/message-changed";

const BOT_USER_ID = "U_BOT_TEST";
const CHANNEL_ID = "C_CHAN";
const TEAM_ID = "T_TEAM";
const MESSAGE_TS = "1700000100.000";
const THREAD_TS = "1700000000.000";
const EDITED_MESSAGE_ID = `${MESSAGE_TS}:message_changed_mention`;

const fakeAdapter = {} as Adapter;

function makeEnvelope(overrides: {
  newText: string;
  prevText: string;
  channel?: string;
  messageTs?: string;
  threadTs?: string;
  user?: string;
}): unknown {
  return {
    type: "event_callback",
    team_id: TEAM_ID,
    event: {
      type: "message",
      subtype: "message_changed",
      channel: overrides.channel ?? CHANNEL_ID,
      message: {
        text: overrides.newText,
        ts: overrides.messageTs ?? MESSAGE_TS,
        thread_ts: overrides.threadTs ?? THREAD_TS,
        user: overrides.user ?? "U_SENDER",
      },
      previous_message: {
        text: overrides.prevText,
      },
    },
  };
}

describe("extractMessageChangedMention", () => {
  it("returns mention when bot mention is newly added in edited message", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);

    expect(result).not.toBeNull();
    if (!result) {
      throw new Error("expected synthesized edited mention");
    }
    expect(result?.threadId).toBe(`slack:${CHANNEL_ID}:${THREAD_TS}`);
    expect(result?.message.text).toBe(`<@${BOT_USER_ID}> please help`);
    expect(result?.message.isMention).toBe(true);
    expect(result?.message.id).toBe(EDITED_MESSAGE_ID);
    expect((result.message.raw as { ts: string }).ts).toBe(MESSAGE_TS);
    expect((result.message.metadata as { edited: boolean }).edited).toBe(true);
  });

  it("serializes the synthesized message for queue rehydration", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);

    expect(result?.message.toJSON()).toEqual({
      _type: "chat:Message",
      attachments: [],
      author: {
        userId: "U_SENDER",
        userName: "U_SENDER",
        fullName: "U_SENDER",
        isBot: false,
        isMe: false,
      },
      formatted: { type: "root", children: [] },
      id: EDITED_MESSAGE_ID,
      isMention: true,
      links: undefined,
      metadata: {
        dateSent: new Date(Number(MESSAGE_TS) * 1000).toISOString(),
        edited: true,
        editedAt: undefined,
      },
      raw: {
        channel: CHANNEL_ID,
        team_id: TEAM_ID,
        ts: MESSAGE_TS,
        thread_ts: THREAD_TS,
        user: "U_SENDER",
      },
      text: `<@${BOT_USER_ID}> please help`,
      threadId: `slack:${CHANNEL_ID}:${THREAD_TS}`,
    });
  });

  it("returns null when bot mention was already in the previous message", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help with more detail`,
      prevText: `<@${BOT_USER_ID}> please help`,
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);
    expect(result).toBeNull();
  });
  it("uses message ts as thread_ts fallback when thread_ts is absent", () => {
    const body = {
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: CHANNEL_ID,
        message: {
          text: `<@${BOT_USER_ID}> help`,
          ts: MESSAGE_TS,
          // no thread_ts
          user: "U_SENDER",
        },
        previous_message: {
          text: "help",
        },
      },
    };

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);
    expect(result?.threadId).toBe(`slack:${CHANNEL_ID}:${MESSAGE_TS}`);
  });
});
