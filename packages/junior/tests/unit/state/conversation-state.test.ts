import { describe, expect, it } from "vitest";
import {
  buildConversationStatePatch,
  coerceThreadConversationState,
  type ThreadConversationState,
} from "@/chat/state/conversation";

describe("conversation state", () => {
  it("defaults vision cache when missing from persisted state", () => {
    const conversation = coerceThreadConversationState({
      conversation: {
        schemaVersion: 1,
        messages: [],
      },
    });

    expect(conversation.vision.byFileId).toEqual({});
  });

  it("ignores any legacy transcript left in the persisted payload", () => {
    const conversation = coerceThreadConversationState({
      conversation: {
        messages: [
          {
            id: "1700000000.100",
            role: "user",
            text: "candidate info",
            createdAtMs: 1700000000100,
            meta: { slackTs: "1700000000.100" },
          },
        ],
        vision: {
          byFileId: {
            F123: {
              summary: "Candidate name appears as Jane Doe.",
              analyzedAtMs: 1700000000500,
            },
            bad: {
              summary: "",
              analyzedAtMs: 10,
            },
          },
        },
      },
    });

    // The visible transcript lives in SQL now; a legacy transcript mirror in a
    // persisted payload is dropped on read.
    expect(conversation.messages).toEqual([]);
    expect(conversation.vision.byFileId).toEqual({
      F123: {
        summary: "Candidate name appears as Jane Doe.",
        analyzedAtMs: 1700000000500,
      },
    });
  });

  it("includes vision cache in state patch payload", () => {
    const state: ThreadConversationState = coerceThreadConversationState({
      conversation: {
        messages: [
          {
            id: "m1",
            role: "user",
            text: "hello",
            createdAtMs: 1,
          },
        ],
        vision: {
          byFileId: {
            F321: {
              summary: "Text includes staff engineer at Example Inc.",
              analyzedAtMs: 99,
            },
          },
        },
      },
    });

    const patch = buildConversationStatePatch(state);
    expect(patch.conversation.vision.byFileId.F321?.summary).toContain(
      "staff engineer",
    );
  });

  it("omits the visible transcript mirror from the persisted patch", () => {
    const conversation = coerceThreadConversationState({
      conversation: { messages: [] },
    });
    conversation.messages.push({
      id: "m1",
      role: "user",
      text: "hello",
      createdAtMs: 1,
    });
    conversation.compactions.push({
      id: "compaction-1",
      summary: "older context",
      coveredMessageIds: ["m1"],
      createdAtMs: 2,
    });
    const patch = buildConversationStatePatch(conversation);
    expect(patch.conversation).not.toHaveProperty("messages");
    expect(patch.conversation).not.toHaveProperty("compactions");
    // Pi history lives in the SQL AgentStepStore; thread-state carries no mirror.
    expect(patch.conversation).not.toHaveProperty("piMessages");
    // The count stat is still derived from the working set for reporting.
    expect(patch.conversation.stats.totalMessageCount).toBe(1);
  });
});
