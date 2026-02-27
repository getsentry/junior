import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listThreadRepliesMock = vi.fn();

vi.mock("chat", () => {
  class MockChat {
    onNewMention() {}
    onSubscribedMessage() {}
    onAssistantThreadStarted() {}
    onAssistantContextChanged() {}
    getAdapter() {
      return {
        setAssistantStatus: async () => undefined,
        setAssistantTitle: async () => undefined,
        setSuggestedPrompts: async () => undefined
      };
    }
  }

  return { Chat: MockChat };
});

vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: () => ({})
}));

vi.mock("@/chat/respond", () => ({
  generateAssistantReply: async () => ({
    text: "ok",
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "test-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true
    }
  })
}));

vi.mock("@/chat/slack-user", () => ({
  lookupSlackUser: async () => undefined
}));

interface TestThread {
  id: string;
  runId?: string;
  readonly state: Promise<Record<string, unknown>>;
  post: (message: unknown) => Promise<unknown>;
  subscribe: () => Promise<void>;
  setState: (state: Record<string, unknown>, options?: { replace?: boolean }) => Promise<void>;
  getState: () => Record<string, unknown>;
}

function createThread(args: { id: string; state?: Record<string, unknown> }): TestThread {
  let stateData: Record<string, unknown> = { ...(args.state ?? {}) };
  return {
    id: args.id,
    get state(): Promise<Record<string, unknown>> {
      return Promise.resolve(stateData);
    },
    async post(message: unknown): Promise<unknown> {
      return message;
    },
    async subscribe(): Promise<void> {},
    async setState(next: Record<string, unknown>, options?: { replace?: boolean }): Promise<void> {
      if (options?.replace) {
        stateData = { ...next };
        return;
      }
      stateData = { ...stateData, ...next };
    },
    getState() {
      return stateData;
    }
  };
}

describe("bot image hydration", () => {
  beforeEach(() => {
    listThreadRepliesMock.mockReset();
  });
  afterEach(async () => {
    const { resetBotDepsForTests } = await import("@/chat/bot");
    resetBotDepsForTests();
  });

  it("hydrates thread image backfill once across agent instances with shared state", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000000.100",
        files: []
      }
    ]);

    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      listThreadReplies: listThreadRepliesMock
    });
    const firstThread = createThread({
      id: "thread-image-hydration",
      state: {
        conversation: {
          schemaVersion: 1,
          messages: [
            {
              id: "1700000000.100",
              role: "user",
              text: "candidate profile image posted earlier",
              createdAtMs: 1700000000100,
              meta: {
                slackTs: "1700000000.100"
              },
              author: {
                userId: "U-user",
                userName: "user"
              }
            }
          ],
          compactions: [],
          backfill: {
            completedAtMs: 1700000000000,
            source: "recent_messages"
          },
          processing: {},
          stats: {
            estimatedContextTokens: 0,
            totalMessageCount: 1,
            compactedMessageCount: 0,
            updatedAtMs: 1700000000000
          },
          vision: {
            byFileId: {}
          }
        }
      }
    });

    await appSlackRuntime.handleNewMention(firstThread as any, {
      id: "1700000000.200",
      text: "/brief on this candidate",
      isMention: true,
      threadId: "thread-image-hydration",
      threadTs: "1700000000.000",
      channelId: "C-image",
      author: {
        userId: "U-user",
        userName: "user",
        fullName: "User Example",
        isMe: false
      }
    });

    const persisted = firstThread.getState();
    const secondThread = createThread({
      id: "thread-image-hydration",
      state: persisted
    });

    await appSlackRuntime.handleNewMention(secondThread as any, {
      id: "1700000000.300",
      text: "follow up without new images",
      isMention: true,
      threadId: "thread-image-hydration",
      threadTs: "1700000000.000",
      channelId: "C-image",
      author: {
        userId: "U-user",
        userName: "user",
        fullName: "User Example",
        isMe: false
      }
    });

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
  });
});
