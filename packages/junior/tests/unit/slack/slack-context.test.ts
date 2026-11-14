import { Message } from "chat";
import { describe, expect, it } from "vitest";
import {
  resolveSlackChannelIdFromMessage,
  slackThreadIdOfMessage,
} from "@/chat/slack/context";
import {
  parseSlackThreadId,
  parseSlackThreadReference,
} from "@/chat/slack/ids";

function slackMessage(args: {
  raw: Record<string, unknown>;
  threadId: string;
}): Message {
  return new Message({
    attachments: [],
    author: {
      fullName: "Person",
      isBot: false,
      isMe: false,
      userId: "U123",
      userName: "person",
    },
    formatted: { type: "root", children: [] },
    id: "message-1",
    metadata: { dateSent: new Date(0), edited: false },
    raw: args.raw,
    text: "hello",
    threadId: args.threadId,
  });
}

describe("slack context", () => {
  it("prefers message.channelId when available", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        channelId: "C123",
        raw: { channel: "C456" },
        threadId: "slack:C789:1700000000.100",
      }),
    ).toBe("C123");
  });

  it("falls back to raw.channel when message.channelId is absent", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        raw: { channel: "C456" },
        threadId: "slack:C789:1700000000.100",
      }),
    ).toBe("C456");
  });

  it("does not read the channel from Message.threadId", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        threadId: "slack:C789:1700000000.100",
      }),
    ).toBeUndefined();
  });

  it("trims whitespace from extracted channel ids", () => {
    expect(
      resolveSlackChannelIdFromMessage({
        channelId: " C123 ",
      }),
    ).toBe("C123");
    expect(
      resolveSlackChannelIdFromMessage({
        raw: { channel: " C456 " },
      }),
    ).toBe("C456");
  });
});

describe("slackThreadIdOfMessage", () => {
  it("reads the thread from the raw Slack event, not Message.threadId", () => {
    expect(
      slackThreadIdOfMessage(
        slackMessage({
          raw: {
            channel: "C123",
            thread_ts: "1700000000.100",
            ts: "1700000000.200",
          },
          threadId: "agent-dispatch:watch-1",
        }),
      ),
    ).toBe("slack:C123:1700000000.100");
  });

  it("uses the message ts for a thread root", () => {
    expect(
      slackThreadIdOfMessage(
        slackMessage({
          raw: { channel: "C123", ts: "1700000000.200" },
          threadId: "slack:C123:1700000000.200",
        }),
      ),
    ).toBe("slack:C123:1700000000.200");
  });

  it("returns undefined without a raw Slack channel and ts", () => {
    expect(
      slackThreadIdOfMessage(
        slackMessage({ raw: {}, threadId: "slack:C123:1700000000.200" }),
      ),
    ).toBeUndefined();
  });
});

describe("parseSlackThreadReference", () => {
  it("parses a valid reference into a thread id", () => {
    const threadId = parseSlackThreadReference("slack:C123:1700000000.100");
    expect(threadId).toBe("slack:C123:1700000000.100");
    expect(threadId && parseSlackThreadId(threadId)).toEqual({
      channelId: "C123",
      threadTs: "1700000000.100",
    });
  });

  it("trims whitespace around references", () => {
    expect(parseSlackThreadReference(" slack:C123:1700000000.100 ")).toBe(
      "slack:C123:1700000000.100",
    );
    expect(parseSlackThreadReference("slack: C123 : 1700000000.100 ")).toBe(
      "slack:C123:1700000000.100",
    );
  });

  it("rejects malformed references", () => {
    expect(parseSlackThreadReference("slack::1700000000.100")).toBeUndefined();
    expect(parseSlackThreadReference("slack:C123:")).toBeUndefined();
    expect(parseSlackThreadReference("slack: : ")).toBeUndefined();
    expect(parseSlackThreadReference("slack:C123")).toBeUndefined();
    expect(
      parseSlackThreadReference("not-slack:C123:1700000000.100"),
    ).toBeUndefined();
    expect(parseSlackThreadReference("agent-dispatch:watch-1")).toBeUndefined();
    expect(parseSlackThreadReference(undefined)).toBeUndefined();
  });
});
