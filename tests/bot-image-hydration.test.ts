import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Author, Message, Thread, SentMessage, Channel, Adapter } from "chat";

const listThreadRepliesMock = vi.fn();

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

function parseChannelFromThreadId(threadId: string): string | undefined {
  const parts = threadId.split(":");
  if (parts.length === 3 && parts[0] === "slack" && parts[1]) return parts[1];
  return undefined;
}

const stubAdapter = {} as Adapter;

function createStubChannel(stateRef?: { value: Record<string, unknown> }): Channel {
  const ref = stateRef ?? { value: {} };
  return {
    adapter: stubAdapter,
    id: "stub-channel",
    isDM: false,
    get messages(): AsyncIterable<Message> {
      return (async function* () {})();
    },
    get name() {
      return null;
    },
    mentionUser(userId: string) {
      return `<@${userId}>`;
    },
    post: vi.fn().mockResolvedValue(undefined) as unknown as Channel["post"],
    postEphemeral: vi.fn().mockResolvedValue(null) as unknown as Channel["postEphemeral"],
    get state(): Promise<Record<string, unknown> | null> {
      return Promise.resolve(ref.value);
    },
    async setState(next: Partial<Record<string, unknown>>, options?: { replace?: boolean }): Promise<void> {
      if (options?.replace) {
        ref.value = { ...(next as Record<string, unknown>) };
        return;
      }
      ref.value = { ...ref.value, ...(next as Record<string, unknown>) };
    },
    async startTyping(): Promise<void> {},
    fetchMetadata: vi.fn().mockResolvedValue({ id: "stub-channel", metadata: {} }) as unknown as Channel["fetchMetadata"],
    threads(): AsyncIterable<never> {
      return (async function* () {})();
    }
  } satisfies Channel;
}

function createTestThread(args: {
  id: string;
  state?: Record<string, unknown>;
}): Thread & { getState: () => Record<string, unknown> } {
  let stateData: Record<string, unknown> = { ...(args.state ?? {}) };
  const channelId = parseChannelFromThreadId(args.id) ?? args.id;
  const channel = createStubChannel();

  const thread: Thread & { getState: () => Record<string, unknown> } = {
    adapter: stubAdapter,
    id: args.id,
    channelId,
    isDM: false,
    channel,
    get allMessages(): AsyncIterable<Message> {
      return (async function* () {})();
    },
    get messages(): AsyncIterable<Message> {
      return (async function* () {})();
    },
    recentMessages: [],
    get state(): Promise<Record<string, unknown> | null> {
      return Promise.resolve(stateData);
    },
    async post(message: unknown): Promise<SentMessage> {
      return { id: "sent-1", text: String(message) } as unknown as SentMessage;
    },
    postEphemeral: vi.fn().mockResolvedValue(null) as unknown as Thread["postEphemeral"],
    async startTyping(): Promise<void> {},
    async subscribe(): Promise<void> {},
    async unsubscribe(): Promise<void> {},
    async isSubscribed(): Promise<boolean> {
      return false;
    },
    async refresh(): Promise<void> {},
    mentionUser(userId: string): string {
      return `<@${userId}>`;
    },
    async setState(next: Partial<Record<string, unknown>>, options?: { replace?: boolean }): Promise<void> {
      if (options?.replace) {
        stateData = { ...(next as Record<string, unknown>) };
        return;
      }
      stateData = { ...stateData, ...(next as Record<string, unknown>) };
    },
    createSentMessageFromMessage(message: Message): SentMessage {
      return message as unknown as SentMessage;
    },
    getState() {
      return stateData;
    }
  };

  return thread;
}

function createTestMessage(args: {
  id: string;
  text: string;
  threadId: string;
  author: Author;
  isMention?: boolean;
}): Message {
  return {
    id: args.id,
    threadId: args.threadId,
    text: args.text,
    author: args.author,
    isMention: args.isMention,
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    formatted: { type: "root", children: [] },
    raw: {},
    toJSON() {
      return {} as ReturnType<Message["toJSON"]>;
    }
  } as unknown as Message;
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
    const firstThread = createTestThread({
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

    await appSlackRuntime.handleNewMention(
      firstThread,
      createTestMessage({
        id: "1700000000.200",
        text: "/brief on this candidate",
        threadId: "slack:C_IMAGE:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false
        }
      })
    );

    const persisted = firstThread.getState();
    const secondThread = createTestThread({
      id: "slack:C_IMAGE:1700000000.000",
      state: persisted
    });

    await appSlackRuntime.handleNewMention(
      secondThread,
      createTestMessage({
        id: "1700000000.300",
        text: "follow up without new images",
        threadId: "slack:C_IMAGE:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false
        }
      })
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("includes generated files in thread.post via SDK file upload", async () => {
    const generatedFile = {
      data: Buffer.from("fake-png"),
      filename: "generated.png",
      mimeType: "image/png"
    };

    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
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

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C_UPLOAD:1700000000.000",
      state: {}
    });
    thread.post = postSpy as unknown as Thread["post"];

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000000.200",
        text: "generate an image",
        threadId: "slack:C_UPLOAD:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false
        }
      })
    );

    const filePost = postSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "files" in (call[0] as Record<string, unknown>) &&
        Array.isArray((call[0] as { files?: unknown[] }).files) &&
        ((call[0] as { files: unknown[] }).files).length > 0
    );
    expect(filePost).toBeDefined();
    expect((filePost![0] as { files: Array<{ filename: string }> }).files[0].filename).toBe("generated.png");
  });

  it("posts files separately when streamed reply is already in progress", async () => {
    const { appSlackRuntime, setBotDepsForTests } = await import("@/chat/bot");
    setBotDepsForTests({
      listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
      generateAssistantReply: async (_text: string, context: any) => {
        context?.onTextDelta?.("streamed ");
        context?.onTextDelta?.("content");
        return {
          text: "streamed content",
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
        };
      }
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C_STREAM:1700000000.000",
      state: {}
    });
    thread.post = postSpy as unknown as Thread["post"];

    await appSlackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000000.200",
        text: "generate an image with streaming",
        threadId: "slack:C_STREAM:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false
        }
      })
    );

    // Should have at least 2 posts: the streamed reply and the file upload
    expect(postSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
