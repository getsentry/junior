import { describe, expect, it, vi } from "vitest";
import type { Adapter, Message, WebhookOptions } from "chat";
import {
  extractMessageChangedMention,
  handleMessageChangedMention,
  textMentionsBot,
} from "@/chat/ingress/message-changed";

const BOT_USER_ID = "U_BOT_TEST";
const CHANNEL_ID = "C_CHAN";
const MESSAGE_TS = "1700000100.000";
const THREAD_TS = "1700000000.000";

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

describe("textMentionsBot", () => {
  it("returns true when text contains the bot mention token", () => {
    expect(textMentionsBot(`hey <@${BOT_USER_ID}> do this`, BOT_USER_ID)).toBe(
      true,
    );
  });

  it("returns false when text does not contain the bot mention", () => {
    expect(textMentionsBot("hey <@U_SOMEONE_ELSE> do this", BOT_USER_ID)).toBe(
      false,
    );
  });

  it("returns false for empty text", () => {
    expect(textMentionsBot("", BOT_USER_ID)).toBe(false);
  });
});

describe("extractMessageChangedMention", () => {
  it("returns mention when bot mention is newly added in edited message", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help`,
      prevText: "please help",
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);

    expect(result).not.toBeNull();
    expect(result?.threadId).toBe(`slack:${CHANNEL_ID}:${THREAD_TS}`);
    expect(result?.message.text).toBe(`<@${BOT_USER_ID}> please help`);
    expect(result?.message.isMention).toBe(true);
    expect(result?.message.id).toBe(MESSAGE_TS);
    expect((result?.message.metadata as { edited: boolean }).edited).toBe(true);
  });

  it("returns null when bot mention was already in the previous message", () => {
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> please help with more detail`,
      prevText: `<@${BOT_USER_ID}> please help`,
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);
    expect(result).toBeNull();
  });

  it("returns null when new message does not mention the bot", () => {
    const body = makeEnvelope({
      newText: "just an edit with no mention",
      prevText: "just an edit",
    });

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);
    expect(result).toBeNull();
  });

  it("returns null for a non-message_changed event", () => {
    const body = {
      type: "event_callback",
      event: {
        type: "message",
        subtype: "message_deleted",
        channel: CHANNEL_ID,
      },
    };

    const result = extractMessageChangedMention(body, BOT_USER_ID, fakeAdapter);
    expect(result).toBeNull();
  });

  it("returns null for an app_mention event (not message_changed)", () => {
    const body = {
      type: "event_callback",
      event: {
        type: "app_mention",
        text: `<@${BOT_USER_ID}> hello`,
        channel: CHANNEL_ID,
        ts: MESSAGE_TS,
      },
    };

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

describe("handleMessageChangedMention", () => {
  it("calls processMessage and returns true for a qualifying event", () => {
    const processMessage = vi.fn();
    const options: WebhookOptions = { waitUntil: vi.fn() };
    const body = makeEnvelope({
      newText: `<@${BOT_USER_ID}> thanks for looking at this`,
      prevText: "thanks for looking at this",
    });

    const handled = handleMessageChangedMention(
      body,
      BOT_USER_ID,
      fakeAdapter,
      processMessage,
      options,
    );

    expect(handled).toBe(true);
    expect(processMessage).toHaveBeenCalledOnce();
    const [calledAdapter, calledThreadId, calledMessage, calledOptions] =
      processMessage.mock.calls[0] as [
        Adapter,
        string,
        Message,
        WebhookOptions,
      ];
    expect(calledAdapter).toBe(fakeAdapter);
    expect(calledThreadId).toBe(`slack:${CHANNEL_ID}:${THREAD_TS}`);
    expect(calledMessage.isMention).toBe(true);
    expect(calledOptions).toBe(options);
  });

  it("does not call processMessage and returns false for a non-qualifying event", () => {
    const processMessage = vi.fn();
    const body = makeEnvelope({
      newText: "just a regular edit",
      prevText: "just a regular",
    });

    const handled = handleMessageChangedMention(
      body,
      BOT_USER_ID,
      fakeAdapter,
      processMessage,
    );

    expect(handled).toBe(false);
    expect(processMessage).not.toHaveBeenCalled();
  });
});
