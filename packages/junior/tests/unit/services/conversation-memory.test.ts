import { describe, expect, it } from "vitest";
import {
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
