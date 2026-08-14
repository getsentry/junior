import { describe, expect, it } from "vitest";
import {
  appendThreadContextMessages,
  buildConversationContext,
  getThreadTitleSourceMessage,
  normalizeConversationText,
  turnHasReply,
} from "@/chat/services/conversation-memory";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { buildDeterministicAssistantMessageId } from "@/chat/state/turn-id";

describe("conversation memory title source", () => {
  it("selects the earliest human message known for the thread", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "assistant-1",
        role: "assistant",
        text: "How can I help?",
        createdAtMs: 20,
        author: { isBot: true, userName: "junior" },
      },
      {
        id: "user-2",
        role: "user",
        text: "Follow up with more details",
        createdAtMs: 30,
        author: { isBot: false, userId: "U2" },
      },
      {
        id: "user-1",
        role: "user",
        text: "Original incident summary",
        createdAtMs: 10,
        author: { isBot: false, userId: "U1" },
      },
    ];

    expect(getThreadTitleSourceMessage(conversation)?.text).toBe(
      "Original incident summary",
    );
  });

  it("ignores bot-authored user messages when choosing the title source", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "bot-user-1",
        role: "user",
        text: "Synthetic system import",
        createdAtMs: 10,
        author: { isBot: true, userId: "B1" },
      },
      {
        id: "human-1",
        role: "user",
        text: "Real user request",
        createdAtMs: 20,
        author: { isBot: false, userId: "U1" },
      },
    ];

    expect(getThreadTitleSourceMessage(conversation)?.text).toBe(
      "Real user request",
    );
  });
});

describe("normalizeConversationText", () => {
  it("preserves message line breaks while normalizing line endings", () => {
    expect(normalizeConversationText("  first\r\nsecond\rthird  ")).toBe(
      "first\nsecond\nthird",
    );
  });

  it("does not truncate durable message text to the model context budget", () => {
    const text = "x".repeat(4_000);
    expect(normalizeConversationText(text)).toBe(text);
  });
});

describe("buildConversationContext", () => {
  it("returns undefined for an empty conversation", () => {
    const conversation = coerceThreadConversationState({});
    expect(buildConversationContext(conversation)).toBeUndefined();
  });

  it("returns undefined when the only message is excluded via excludeMessageId", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "msg-1",
        role: "user",
        text: "hello",
        createdAtMs: 1000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
    ];
    expect(
      buildConversationContext(conversation, { excludeMessageId: "msg-1" }),
    ).toBeUndefined();
  });

  it("omits the excluded message but keeps prior messages in the transcript", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "msg-1",
        role: "user",
        text: "first message",
        createdAtMs: 1000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
      {
        id: "msg-2",
        role: "user",
        text: "current message",
        createdAtMs: 2000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
    ];
    const context = buildConversationContext(conversation, {
      excludeMessageId: "msg-2",
    });
    expect(context).toContain("first message");
    expect(context).not.toContain("current message");
  });

  it("omits the transcript block when only compactions remain after exclusion", () => {
    const conversation = coerceThreadConversationState({});
    conversation.compactions = [
      {
        id: "compaction-1",
        summary: "Earlier thread summary.",
        coveredMessageCount: 1,
        createdAtMs: 500,
      },
    ];
    conversation.messages = [
      {
        id: "msg-1",
        role: "user",
        text: "current message",
        createdAtMs: 1000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
    ];

    const context = buildConversationContext(conversation, {
      excludeMessageId: "msg-1",
    });

    expect(context).toContain("<thread-compactions>");
    expect(context).toContain("Earlier thread summary.");
    expect(context).not.toContain("<thread-transcript>");
  });

  it("does not render raw Slack ids as author display names", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "msg-1",
        role: "user",
        text: "hello",
        createdAtMs: 1000,
        author: {
          isBot: false,
          userId: "U039RR91S",
          userName: "U039RR91S",
          fullName: "U039RR91S",
        },
      },
    ];

    const context = buildConversationContext(conversation);

    expect(context).toContain('author="user"');
    expect(context).toContain('actor_id="U039RR91S"');
    expect(context).toContain("[user] user: hello");
    expect(context).not.toContain("@U039RR91S");
  });

  it("keeps multiline messages compact in model context", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "msg-1",
        role: "assistant",
        text: "first line\nsecond line",
        createdAtMs: 1000,
      },
    ];

    const context = buildConversationContext(conversation);
    expect(context).toContain("first line second line");
    expect(context).not.toContain("first line\nsecond line");
  });

  it("applies the message character budget only to model context", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "msg-1",
        role: "assistant",
        text: "x".repeat(4_000),
        createdAtMs: 1000,
      },
    ];

    const context = buildConversationContext(conversation);
    const renderedText = /\[assistant\][^\n]*: (x+)/.exec(context ?? "")?.[1];
    expect(renderedText).toHaveLength(3_200);
  });
});

describe("appendThreadContextMessages", () => {
  it("merges passive messages into one existing thread-context envelope", () => {
    const base = [
      '<thread-context authority="evidence-only">',
      '  <message index="1" ts="2026-08-14T21:00:00.000Z" role="user" author="Lamberto" actor_id="ULAMBERTO" slack_ts="1712345.000100">',
      "[user] Lamberto: durable history",
      "  </message>",
      "</thread-context>",
    ].join("\n");

    const merged = appendThreadContextMessages(base, [
      '  <message role="user" author="Bruno" actor_id="UBRUNO" slack_ts="1712345.000200">',
      "[user] Bruno: passive follow-up",
      "  </message>",
    ]);

    expect(merged).toBe(
      [
        '<thread-context authority="evidence-only">',
        '  <message index="1" ts="2026-08-14T21:00:00.000Z" role="user" author="Lamberto" actor_id="ULAMBERTO" slack_ts="1712345.000100">',
        "[user] Lamberto: durable history",
        "  </message>",
        '  <message role="user" author="Bruno" actor_id="UBRUNO" slack_ts="1712345.000200">',
        "[user] Bruno: passive follow-up",
        "  </message>",
        "</thread-context>",
      ].join("\n"),
    );
    expect(merged?.match(/<thread-context/g)).toHaveLength(1);
  });

  it("wraps passive messages when durable context has no thread-context envelope", () => {
    const base = [
      "<thread-compactions>",
      "  <compaction>summary</compaction>",
      "</thread-compactions>",
    ].join("\n");

    expect(
      appendThreadContextMessages(base, [
        '  <message role="user" author="Bruno" actor_id="UBRUNO" slack_ts="1712345.000200">',
        "[user] Bruno: passive only",
        "  </message>",
      ]),
    ).toBe(
      [
        "<thread-compactions>",
        "  <compaction>summary</compaction>",
        "</thread-compactions>",
        "",
        '<thread-context authority="evidence-only">',
        '  <message role="user" author="Bruno" actor_id="UBRUNO" slack_ts="1712345.000200">',
        "[user] Bruno: passive only",
        "  </message>",
        "</thread-context>",
      ].join("\n"),
    );
  });
});

describe("turnHasReply", () => {
  it("recognizes delivered assistant message ids", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: buildDeterministicAssistantMessageId("turn-1"),
        role: "assistant",
        text: "Working on it.",
        createdAtMs: 1,
      },
    ];

    expect(turnHasReply(conversation, "turn-1")).toBe(true);
    expect(turnHasReply(conversation, "turn-2")).toBe(false);
    expect(turnHasReply(conversation, "turn-3")).toBe(false);
  });
});
