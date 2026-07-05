import { describe, expect, it, vi } from "vitest";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { ThreadConversationState } from "@/chat/state/conversation";
import { maybeUpdateAssistantTitle } from "@/chat/slack/assistant-thread/title";

const DM_CHANNEL_ID = "D12345";
const CHANNEL_ID = "C12345";
const PRIVATE_CHANNEL_ID = "G12345";
const THREAD_TS = "1700000000.000001";
const USER_MESSAGE_ID = "msg_001";
const USER_MESSAGE_TEXT = "How do I debug memory leaks in Node?";
const GENERATED_TITLE = "Debugging Node.js Memory Leaks";

function makeConversation(
  override?: Partial<ThreadConversationState>,
): ThreadConversationState {
  return {
    backfill: {},
    compactions: [],
    messages: [
      {
        id: USER_MESSAGE_ID,
        role: "user",
        text: USER_MESSAGE_TEXT,
        createdAtMs: 1700000000000,
      },
    ],
    piMessages: [],
    processing: {},
    schemaVersion: 1,
    stats: {
      compactedMessageCount: 0,
      estimatedContextTokens: 0,
      totalMessageCount: 1,
      updatedAtMs: 1700000000000,
    },
    vision: { byFileId: {} },
    ...override,
  };
}

function makeArtifacts(
  override?: Partial<ThreadArtifactsState>,
): ThreadArtifactsState {
  return { ...override };
}

function makeArgs(
  channelId: string,
  overrides?: {
    artifacts?: Partial<ThreadArtifactsState>;
    generateThreadTitle?: () => Promise<string>;
    setAssistantTitle?: (...args: unknown[]) => Promise<void>;
  },
) {
  const setAssistantTitle =
    overrides?.setAssistantTitle ?? vi.fn().mockResolvedValue(undefined);
  const generateThreadTitle =
    overrides?.generateThreadTitle ??
    vi.fn().mockResolvedValue(GENERATED_TITLE);

  return {
    assistantThreadContext: { channelId, threadTs: THREAD_TS },
    assistantUserName: "junior",
    artifacts: makeArtifacts(overrides?.artifacts),
    channelId,
    conversation: makeConversation(),
    generateThreadTitle,
    getSlackAdapter: () => ({ setAssistantTitle }),
    modelId: "fast-model",
    requesterId: "U0USER",
    runId: "run_001",
    threadId: `slack:${channelId}:${THREAD_TS}`,
    _setAssistantTitle: setAssistantTitle,
  };
}

describe("maybeUpdateAssistantTitle", () => {
  describe("channel thread (non-DM)", () => {
    it("generates and returns a title for a public channel", async () => {
      const args = makeArgs(CHANNEL_ID);
      const result = await maybeUpdateAssistantTitle(args);

      expect(result).toEqual({
        sourceMessageId: USER_MESSAGE_ID,
        title: GENERATED_TITLE,
      });
      expect(args.generateThreadTitle).toHaveBeenCalledWith(USER_MESSAGE_TEXT);
    });

    it("does NOT call setAssistantTitle for a public channel", async () => {
      const args = makeArgs(CHANNEL_ID);
      await maybeUpdateAssistantTitle(args);

      expect(args._setAssistantTitle).not.toHaveBeenCalled();
    });

    it("generates and returns a title for a private channel", async () => {
      const args = makeArgs(PRIVATE_CHANNEL_ID);
      const result = await maybeUpdateAssistantTitle(args);

      expect(result).toEqual({
        sourceMessageId: USER_MESSAGE_ID,
        title: GENERATED_TITLE,
      });
      expect(args._setAssistantTitle).not.toHaveBeenCalled();
    });
  });

  describe("DM thread", () => {
    it("generates a title and calls setAssistantTitle", async () => {
      const args = makeArgs(DM_CHANNEL_ID);
      const result = await maybeUpdateAssistantTitle(args);

      expect(result).toEqual({
        sourceMessageId: USER_MESSAGE_ID,
        title: GENERATED_TITLE,
      });
      expect(args._setAssistantTitle).toHaveBeenCalledWith(
        DM_CHANNEL_ID,
        THREAD_TS,
        GENERATED_TITLE,
      );
    });

    it("returns the generated title even when setAssistantTitle throws a permission error", async () => {
      const permissionError = { data: { error: "no_permission" } };
      const args = makeArgs(DM_CHANNEL_ID, {
        setAssistantTitle: vi.fn().mockRejectedValue(permissionError),
      });

      const result = await maybeUpdateAssistantTitle(args);

      expect(result).toEqual({
        sourceMessageId: USER_MESSAGE_ID,
        title: GENERATED_TITLE,
      });
    });

    it("returns the generated title even when setAssistantTitle throws a non-permission error", async () => {
      const args = makeArgs(DM_CHANNEL_ID, {
        setAssistantTitle: vi.fn().mockRejectedValue(new Error("network fail")),
      });

      const result = await maybeUpdateAssistantTitle(args);

      expect(result).toEqual({
        sourceMessageId: USER_MESSAGE_ID,
        title: GENERATED_TITLE,
      });
    });
  });

  describe("early returns", () => {
    it("returns undefined when assistantThreadContext is missing", async () => {
      const args = {
        ...makeArgs(CHANNEL_ID),
        assistantThreadContext: undefined,
      };
      const result = await maybeUpdateAssistantTitle(args);
      expect(result).toBeUndefined();
    });

    it("returns undefined when there is no human message in the conversation", async () => {
      const args = makeArgs(CHANNEL_ID);
      args.conversation = makeConversation({ messages: [] });
      const result = await maybeUpdateAssistantTitle(args);
      expect(result).toBeUndefined();
      expect(args.generateThreadTitle).not.toHaveBeenCalled();
    });

    it("skips generation when source message id matches existing artifact (dedup)", async () => {
      const args = makeArgs(CHANNEL_ID, {
        artifacts: { assistantTitleSourceMessageId: USER_MESSAGE_ID },
      });
      const result = await maybeUpdateAssistantTitle(args);
      expect(result).toBeUndefined();
      expect(args.generateThreadTitle).not.toHaveBeenCalled();
    });

    it("returns undefined when title generation throws", async () => {
      const args = makeArgs(CHANNEL_ID, {
        generateThreadTitle: vi
          .fn()
          .mockRejectedValue(new Error("model error")),
      });
      const result = await maybeUpdateAssistantTitle(args);
      expect(result).toBeUndefined();
    });
  });
});
