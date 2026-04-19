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
});
