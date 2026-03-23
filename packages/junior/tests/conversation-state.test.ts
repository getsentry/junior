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

  it("coerces message image file ids and vision summaries", () => {
    const conversation = coerceThreadConversationState({
      conversation: {
        messages: [
          {
            id: "1700000000.100",
            role: "user",
            text: "candidate info",
            createdAtMs: 1700000000100,
            meta: {
              imageFileIds: ["F123", "", 10],
              slackTs: "1700000000.100",
            },
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

    expect(conversation.messages[0]?.meta?.imageFileIds).toEqual(["F123"]);
    expect(conversation.messages[0]?.meta?.slackTs).toBe("1700000000.100");
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
});
