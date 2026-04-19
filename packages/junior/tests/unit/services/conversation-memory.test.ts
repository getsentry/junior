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

describe("buildConversationContext structured markers", () => {
  it("returns undefined for an empty conversation", () => {
    const conversation = coerceThreadConversationState({});
    expect(buildConversationContext(conversation)).toBeUndefined();
  });

  it("wraps each transcript message with an indexed element carrying role and ts metadata", () => {
    const conversation = coerceThreadConversationState({});
    conversation.messages = [
      {
        id: "u-1",
        role: "user",
        text: "first ask",
        createdAtMs: 1_700_000_000_000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
      {
        id: "a-1",
        role: "assistant",
        text: "first reply",
        createdAtMs: 1_700_000_060_000,
        author: { isBot: true, userName: "junior" },
      },
    ];

    const output = buildConversationContext(conversation) ?? "";

    expect(output).toContain("<thread-transcript>");
    expect(output).toContain("</thread-transcript>");
    expect(output).toContain(
      '<message index="1" ts="2023-11-14T22:13:20.000Z" role="user" author="alice">',
    );
    expect(output).toContain(
      '<message index="2" ts="2023-11-14T22:14:20.000Z" role="assistant" author="junior">',
    );
  });

  it("wraps each compaction with index, covered_messages, and created_at attrs", () => {
    const conversation = coerceThreadConversationState({});
    conversation.compactions = [
      {
        id: "c-1",
        summary:
          "<active-asks>\n- narrow scope to org:ci\n</active-asks>\n<superseded-or-completed-asks>\n- remove project:admin (replaced by read-only scope)\n</superseded-or-completed-asks>\n<facts>\n- repo: getsentry/junior\n</facts>",
        coveredMessageIds: ["m-1", "m-2", "m-3"],
        createdAtMs: 1_700_000_000_000,
      },
    ];
    conversation.messages = [
      {
        id: "u-latest",
        role: "user",
        text: "latest ask",
        createdAtMs: 1_700_000_120_000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
    ];

    const output = buildConversationContext(conversation) ?? "";

    expect(output).toContain("<thread-compactions>");
    expect(output).toContain("</thread-compactions>");
    expect(output).toContain(
      '<compaction index="1" covered_messages="3" created_at="2023-11-14T22:13:20.000Z">',
    );
    expect(output).toContain("<active-asks>");
    expect(output).toContain("<superseded-or-completed-asks>");
    expect(output).toContain("<facts>");
  });

  it("emits compactions before the transcript when both are present", () => {
    const conversation = coerceThreadConversationState({});
    conversation.compactions = [
      {
        id: "c-1",
        summary: "<active-asks></active-asks>",
        coveredMessageIds: ["m-1"],
        createdAtMs: 1_700_000_000_000,
      },
    ];
    conversation.messages = [
      {
        id: "u-1",
        role: "user",
        text: "latest ask",
        createdAtMs: 1_700_000_060_000,
        author: { isBot: false, userId: "U1", userName: "alice" },
      },
    ];

    const output = buildConversationContext(conversation) ?? "";
    const compactionsIndex = output.indexOf("<thread-compactions>");
    const transcriptIndex = output.indexOf("<thread-transcript>");

    expect(compactionsIndex).toBeGreaterThanOrEqual(0);
    expect(transcriptIndex).toBeGreaterThan(compactionsIndex);
  });
});
