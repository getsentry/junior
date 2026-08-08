import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateConversationMessages } from "@/chat/conversations/messages";
import type { ConversationEvent } from "@/chat/conversations/history";
import { coerceThreadConversationState } from "@/chat/state/conversation";

const loadMessageHistory = vi.fn();

vi.mock("@/chat/db", () => ({
  getConversationEventStore: () => ({
    loadMessageHistory,
  }),
}));

function messageEvent(
  seq: number,
  messageId: string,
  text: string,
): ConversationEvent {
  return {
    schemaVersion: 1,
    seq,
    historyVersion: 0,
    createdAtMs: seq * 1_000,
    data: {
      type: "message",
      messageId,
      role: "user",
      text,
    },
  };
}

describe("hydrateConversationMessages", () => {
  beforeEach(() => {
    loadMessageHistory.mockReset();
  });

  it("rebuilds stats and backfill from SQL history without Redis mirrors", async () => {
    loadMessageHistory.mockResolvedValue({
      historyFromSeq: 0,
      events: [
        messageEvent(0, "m1", "hello"),
        messageEvent(1, "m2", "world"),
      ],
      compaction: {
        schemaVersion: 1,
        seq: 2,
        historyVersion: 0,
        createdAtMs: 3_000,
        data: {
          type: "messages_summarized",
          historyFromSeq: 0,
          compactions: [
            {
              id: "compaction-1",
              summary: "earlier context",
              coveredMessageCount: 4,
              createdAtMs: 2_500,
            },
          ],
        },
      },
    });

    const conversation = coerceThreadConversationState({
      conversation: {
        // Legacy Redis mirrors must not win once SQL hydrate runs.
        backfill: {},
        stats: {
          estimatedContextTokens: 999,
          totalMessageCount: 99,
          compactedMessageCount: 99,
          updatedAtMs: 1,
        },
      },
    });

    await hydrateConversationMessages({
      conversation,
      conversationId: "conv-1",
    });

    expect(conversation.messages.map((message) => message.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(conversation.compactions).toEqual([
      {
        id: "compaction-1",
        summary: "earlier context",
        coveredMessageCount: 4,
        createdAtMs: 2_500,
      },
    ]);
    expect(conversation.stats.totalMessageCount).toBe(2);
    expect(conversation.stats.compactedMessageCount).toBe(4);
    expect(conversation.stats.estimatedContextTokens).toBeGreaterThan(0);
    expect(conversation.backfill.completedAtMs).toEqual(expect.any(Number));
    expect(conversation.backfill.source).toBe("recent_messages");
  });

  it("leaves empty conversations unmarked so Slack backfill can still run", async () => {
    loadMessageHistory.mockResolvedValue({
      historyFromSeq: 0,
      events: [],
      compaction: undefined,
    });

    const conversation = coerceThreadConversationState({});
    await hydrateConversationMessages({
      conversation,
      conversationId: "conv-empty",
    });

    expect(conversation.messages).toEqual([]);
    expect(conversation.compactions).toEqual([]);
    expect(conversation.backfill.completedAtMs).toBeUndefined();
    expect(conversation.stats.totalMessageCount).toBe(0);
    expect(conversation.stats.compactedMessageCount).toBe(0);
  });
});
