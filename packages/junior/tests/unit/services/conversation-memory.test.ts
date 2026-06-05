import { describe, expect, it } from "vitest";
import {
  buildConversationContext,
  getThreadTitleSourceMessage,
} from "@/chat/services/conversation-memory";
import { coerceThreadConversationState } from "@/chat/state/conversation";

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
        coveredMessageIds: ["msg-0"],
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
});
