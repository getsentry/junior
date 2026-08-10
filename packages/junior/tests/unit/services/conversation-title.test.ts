import { describe, expect, it, vi } from "vitest";
import { ensureConversationTitle } from "@/chat/services/conversation-title";
import type { ThreadConversationState } from "@/chat/state/conversation";

const CONVERSATION_ID = "local:web:title-1";
const USER_MESSAGE_TEXT = "How do I debug memory leaks in Node?";
const GENERATED_TITLE = "Debugging Node.js Memory Leaks";

function makeConversation(
  override?: Partial<ThreadConversationState>,
): ThreadConversationState {
  return {
    compactions: [],
    messages: [
      {
        id: "msg_001",
        role: "user",
        text: USER_MESSAGE_TEXT,
        createdAtMs: 1_700_000_000_000,
      },
    ],
    processing: {},
    schemaVersion: 1,
    vision: { byFileId: {} },
    ...override,
  };
}

describe("ensureConversationTitle", () => {
  it("generates and persists a title when the conversation has none", async () => {
    const recordActivity = vi.fn().mockResolvedValue(undefined);
    const generateThreadTitle = vi.fn().mockResolvedValue(GENERATED_TITLE);
    const store = {
      get: vi.fn().mockResolvedValue({ conversationId: CONVERSATION_ID }),
      recordActivity,
    };

    const title = await ensureConversationTitle({
      activityAtMs: 1_700_000_000_000,
      conversation: makeConversation(),
      conversationId: CONVERSATION_ID,
      conversationStore: store,
      generateThreadTitle,
      nowMs: 1_700_000_000_100,
    });

    expect(title).toBe(GENERATED_TITLE);
    expect(generateThreadTitle).toHaveBeenCalledWith(USER_MESSAGE_TEXT);
    expect(recordActivity).toHaveBeenCalledWith({
      activityAtMs: 1_700_000_000_000,
      conversationId: CONVERSATION_ID,
      nowMs: 1_700_000_000_100,
      title: GENERATED_TITLE,
    });
  });

  it("skips generation when a title is already stored", async () => {
    const generateThreadTitle = vi.fn().mockResolvedValue(GENERATED_TITLE);
    const recordActivity = vi.fn().mockResolvedValue(undefined);

    const title = await ensureConversationTitle({
      conversation: makeConversation(),
      conversationId: CONVERSATION_ID,
      conversationStore: {
        get: vi.fn().mockResolvedValue({
          conversationId: CONVERSATION_ID,
          title: "Existing Title",
        }),
        recordActivity,
      },
      generateThreadTitle,
    });

    expect(title).toBeUndefined();
    expect(generateThreadTitle).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("skips child conversations", async () => {
    const generateThreadTitle = vi.fn().mockResolvedValue(GENERATED_TITLE);
    const recordActivity = vi.fn().mockResolvedValue(undefined);

    const title = await ensureConversationTitle({
      conversation: makeConversation(),
      conversationId: "child-1",
      conversationStore: {
        get: vi.fn().mockResolvedValue({
          conversationId: "child-1",
          lineage: { parentConversationId: "parent-1" },
        }),
        recordActivity,
      },
      generateThreadTitle,
    });

    expect(title).toBeUndefined();
    expect(generateThreadTitle).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("skips when there is no human message", async () => {
    const generateThreadTitle = vi.fn().mockResolvedValue(GENERATED_TITLE);
    const recordActivity = vi.fn().mockResolvedValue(undefined);

    const title = await ensureConversationTitle({
      conversation: makeConversation({ messages: [] }),
      conversationId: CONVERSATION_ID,
      conversationStore: {
        get: vi.fn().mockResolvedValue({ conversationId: CONVERSATION_ID }),
        recordActivity,
      },
      generateThreadTitle,
    });

    expect(title).toBeUndefined();
    expect(generateThreadTitle).not.toHaveBeenCalled();
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("returns undefined when title generation throws", async () => {
    const recordActivity = vi.fn().mockResolvedValue(undefined);

    const title = await ensureConversationTitle({
      conversation: makeConversation(),
      conversationId: CONVERSATION_ID,
      conversationStore: {
        get: vi.fn().mockResolvedValue({ conversationId: CONVERSATION_ID }),
        recordActivity,
      },
      generateThreadTitle: vi.fn().mockRejectedValue(new Error("model error")),
    });

    expect(title).toBeUndefined();
    expect(recordActivity).not.toHaveBeenCalled();
  });
});
