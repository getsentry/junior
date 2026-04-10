import { describe, expect, it, vi } from "vitest";
import { dispatchMessageChangedMention } from "@/chat/ingress/message-changed";

/**
 * Minimal stub for the SlackAdapter interface surface used by dispatchMessageChangedMention.
 */
function makeAdapterStub(botUserId: string | undefined) {
  return {
    botUserId,
    parseMessage: vi.fn((event: unknown) => ({
      isMention: false,
      raw: event,
    })),
  };
}

/**
 * Minimal stub for the JuniorChat interface used by dispatchMessageChangedMention.
 */
function makeBotStub(botUserId: string | undefined) {
  const adapter = makeAdapterStub(botUserId);
  return {
    getAdapter: vi.fn(() => adapter),
    processMessage: vi.fn(),
    _adapter: adapter,
  };
}

function makeOptions() {
  return { waitUntil: vi.fn() };
}

function makeMessageChangedPayload(overrides: {
  newText?: string;
  prevText?: string;
  channel?: string;
  ts?: string;
  messageTs?: string;
  threadTs?: string;
  teamId?: string;
  botId?: string;
}) {
  return {
    type: "event_callback",
    team_id: overrides.teamId ?? "T_TEST",
    event: {
      type: "message",
      subtype: "message_changed",
      channel: overrides.channel ?? "C_TEST",
      ts: overrides.ts ?? "1700000001.000",
      message: {
        type: "message",
        user: "U_USER",
        text: overrides.newText ?? "",
        ts: overrides.messageTs ?? "1700000000.500",
        thread_ts: overrides.threadTs,
        ...(overrides.botId ? { bot_id: overrides.botId } : {}),
      },
      previous_message: {
        text: overrides.prevText ?? "",
      },
    },
  };
}

describe("dispatchMessageChangedMention", () => {
  it("dispatches processMessage when @mention is newly added in an edit", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();
    const payload = makeMessageChangedPayload({
      newText: "hello <@U_BOT> can you help?",
      prevText: "hello can you help?",
    });

    const result = dispatchMessageChangedMention(
      payload,
      bot as never,
      options,
    );

    expect(result).toBe(true);
    expect(bot.processMessage).toHaveBeenCalledOnce();
    const [, threadId, msg] = bot.processMessage.mock.calls[0] as [
      unknown,
      string,
      { isMention: boolean },
    ];
    expect(threadId).toBe("slack:C_TEST:1700000000.500");
    expect(msg.isMention).toBe(true);
  });

  it("uses thread_ts as threadId when present", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();
    const payload = makeMessageChangedPayload({
      newText: "<@U_BOT>",
      prevText: "",
      threadTs: "1700000000.100",
      messageTs: "1700000000.500",
    });

    dispatchMessageChangedMention(payload, bot as never, options);

    const [, threadId] = bot.processMessage.mock.calls[0] as [unknown, string];
    expect(threadId).toBe("slack:C_TEST:1700000000.100");
  });

  it("returns false and does not dispatch when mention was already present", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();
    const payload = makeMessageChangedPayload({
      newText: "hello <@U_BOT>",
      prevText: "hello <@U_BOT>",
    });

    const result = dispatchMessageChangedMention(
      payload,
      bot as never,
      options,
    );

    expect(result).toBe(false);
    expect(bot.processMessage).not.toHaveBeenCalled();
  });

  it("returns false and does not dispatch when mention is absent in new text", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();
    const payload = makeMessageChangedPayload({
      newText: "just a plain edit",
      prevText: "just a plain",
    });

    const result = dispatchMessageChangedMention(
      payload,
      bot as never,
      options,
    );

    expect(result).toBe(false);
    expect(bot.processMessage).not.toHaveBeenCalled();
  });

  it("returns false for non-event_callback payloads", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();

    const result = dispatchMessageChangedMention(
      { type: "url_verification", challenge: "abc" },
      bot as never,
      options,
    );

    expect(result).toBe(false);
    expect(bot.processMessage).not.toHaveBeenCalled();
  });

  it("returns false for non-message_changed subtypes", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();
    const payload = {
      type: "event_callback",
      event: { type: "message", subtype: "bot_message", text: "<@U_BOT>" },
    };

    const result = dispatchMessageChangedMention(
      payload,
      bot as never,
      options,
    );

    expect(result).toBe(false);
    expect(bot.processMessage).not.toHaveBeenCalled();
  });

  it("returns false and does not dispatch when bot has no known botUserId", () => {
    const bot = makeBotStub(undefined);
    const options = makeOptions();
    const payload = makeMessageChangedPayload({
      newText: "<@U_UNKNOWN>",
      prevText: "",
    });

    const result = dispatchMessageChangedMention(
      payload,
      bot as never,
      options,
    );

    expect(result).toBe(false);
    expect(bot.processMessage).not.toHaveBeenCalled();
  });

  it("skips bot-authored edits", () => {
    const bot = makeBotStub("U_BOT");
    const options = makeOptions();
    const payload = makeMessageChangedPayload({
      newText: "<@U_BOT>",
      prevText: "",
      botId: "B_SOME_BOT",
    });

    const result = dispatchMessageChangedMention(
      payload,
      bot as never,
      options,
    );

    expect(result).toBe(false);
    expect(bot.processMessage).not.toHaveBeenCalled();
  });
});
