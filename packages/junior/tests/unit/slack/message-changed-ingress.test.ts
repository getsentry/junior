import { describe, expect, it } from "vitest";
import type { Adapter } from "chat";
import { extractMessageChangedMention } from "@/chat/ingress/message-changed";

const BOT_USER_ID = "U0BOTTEST";
const CHANNEL_ID = "C0CHAN";
const TEAM_ID = "T0TEAM";
const MESSAGE_TS = "1700000100.000";
const THREAD_TS = "1700000000.000";
const EDITED_MESSAGE_ID = `${MESSAGE_TS}:message_changed_mention`;

const fakeAdapter = {} as Adapter;

function makeEnvelope(overrides: {
  newText: string;
  prevText: string;
  botId?: string;
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
        user: overrides.user ?? "U0SENDER",
        ...(overrides.botId ? { bot_id: overrides.botId } : {}),
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

    const serialized = result?.message.toJSON();

    expect(serialized).toMatchObject({
      _type: "chat:Message",
      attachments: [],
      author: {
        userId: "U0SENDER",
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
        user: "U0SENDER",
      },
      text: `<@${BOT_USER_ID}> please help`,
      threadId: `slack:${CHANNEL_ID}:${THREAD_TS}`,
    });
    expect(serialized?.author.userName).toBe("");
    expect(serialized?.author.fullName).toBe("");
  });

  it("derives bot author flags from the edited payload", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
      botId: "B_APP",
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);

    expect(result?.message.author.isBot).toBe(true);
    expect(result?.message.author.isMe).toBe(false);
    expect(
      (result?.message.raw as { bot_id?: string } | undefined)?.bot_id,
    ).toBe("B_APP");
  });

  it("marks self-authored edits with isMe", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
      user: BOT_USER_ID,
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);

    expect(result?.message.author.isMe).toBe(true);
  });

  it("returns null when bot mention was already in the previous message", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help with more detail`,
      prevText: `<@${BOT_USER_ID}> please help`,
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);
    expect(result).toBeNull();
  });

  it("returns null when the edited message has no actor user id", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
      user: "",
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);

    expect(result).toBeNull();
  });

  it("returns null when the edited message has a synthetic unknown actor id", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
      user: "unknown",
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
          user: "U0SENDER",
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
