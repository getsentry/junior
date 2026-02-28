import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listThreadRepliesMock = vi.fn();
const uploadFilesToThreadMock = vi.fn();

vi.mock("chat", () => {
  class MockChat {
    onNewMention() {}
    onSubscribedMessage() {}
    onAssistantThreadStarted() {}
    onAssistantContextChanged() {}
    getAdapter() {
      return {
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
  channelId?: string;
  runId?: string;
  readonly state: Promise<Record<string, unknown>>;
  post: (message: unknown) => Promise<unknown>;
  startTyping: (status?: string) => Promise<void>;
  subscribe: () => Promise<void>;
  setState: (state: Record<string, unknown>, options?: { replace?: boolean }) => Promise<void>;
  getState: () => Record<string, unknown>;
}

function parseChannelFromThreadId(threadId: string): string | undefined {
  const parts = threadId.split(":");
  if (parts.length === 3 && parts[0] === "slack" && parts[1]) return parts[1];
  return undefined;
}

function createThread(args: { id: string; state?: Record<string, unknown> }): TestThread {
  let stateData: Record<string, unknown> = { ...(args.state ?? {}) };
  return {
    id: args.id,
    channelId: parseChannelFromThreadId(args.id),
    get state(): Promise<Record<string, unknown>> {
      return Promise.resolve(stateData);
    },
    async post(message: unknown): Promise<unknown> {
      return message;
    },
    async startTyping(): Promise<void> {},
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
      id: "slack:C_IMAGE:1700000000.000",
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
      threadId: "slack:C_IMAGE:1700000000.000",
      channelId: "C_IMAGE",
      author: {
        userId: "U-user",
        userName: "user",
        fullName: "User Example",
        isMe: false
      }
    });

    const persisted = firstThread.getState();
    const secondThread = createThread({
      id: "slack:C_IMAGE:1700000000.000",
      state: persisted
    });

    await appSlackRuntime.handleNewMention(secondThread as any, {
      id: "1700000000.300",
      text: "follow up without new images",
      isMention: true,
      threadId: "slack:C_IMAGE:1700000000.000",
      channelId: "C_IMAGE",
      author: {
        userId: "U-user",
        userName: "user",
        fullName: "User Example",
        isMe: false
      }
    });

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("uploads generated files to Slack thread via uploadFilesToThread", async () => {
    const generatedFile = {
      data: Buffer.from("fake-png"),
      filename: "generated.png",
      mimeType: "image/png"
    };

    uploadFilesToThreadMock.mockReset();
    uploadFilesToThreadMock.mockResolvedValue(undefined);

    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
      uploadFilesToThread: uploadFilesToThreadMock,
      generateAssistantReply: async () => ({
        text: "Here is your image",
        files: [generatedFile],
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success" as const,
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true
        }
      })
    });

    const thread = createThread({
      id: "slack:C_UPLOAD:1700000000.000",
      state: {}
    });

    await appSlackRuntime.handleNewMention(thread as any, {
      id: "1700000000.200",
      text: "generate an image",
      isMention: true,
      threadId: "slack:C_UPLOAD:1700000000.000",
      channelId: "C_UPLOAD",
      author: {
        userId: "U-user",
        userName: "user",
        fullName: "User Example",
        isMe: false
      }
    });

    expect(uploadFilesToThreadMock).toHaveBeenCalledTimes(1);
    expect(uploadFilesToThreadMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C_UPLOAD",
        threadTs: "1700000000.000",
        files: [
          expect.objectContaining({
            filename: "generated.png"
          })
        ]
      })
    );
  });

  it("posts error message when file upload fails", async () => {
    uploadFilesToThreadMock.mockReset();
    uploadFilesToThreadMock.mockRejectedValue(new Error("upload failed"));

    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
      uploadFilesToThread: uploadFilesToThreadMock,
      generateAssistantReply: async () => ({
        text: "Here is your image",
        files: [
          {
            data: Buffer.from("fake-png"),
            filename: "generated.png",
            mimeType: "image/png"
          }
        ],
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "test-model",
          outcome: "success" as const,
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true
        }
      })
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createThread({
      id: "slack:C_UPLOADFAIL:1700000000.000",
      state: {}
    });
    thread.post = postSpy;

    await appSlackRuntime.handleNewMention(thread as any, {
      id: "1700000000.200",
      text: "generate an image",
      isMention: true,
      threadId: "slack:C_UPLOADFAIL:1700000000.000",
      channelId: "C_UPLOADFAIL",
      author: {
        userId: "U-user",
        userName: "user",
        fullName: "User Example",
        isMe: false
      }
    });

    expect(uploadFilesToThreadMock).toHaveBeenCalledTimes(1);

    const errorPost = postSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "markdown" in (call[0] as Record<string, unknown>) &&
        String((call[0] as { markdown: string }).markdown).includes("failed to upload")
    );
    expect(errorPost).toBeDefined();
  });
});
