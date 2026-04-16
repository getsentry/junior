import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "chat";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

const listThreadRepliesMock = vi.fn();
const ORIGINAL_ENV = { ...process.env };

async function createRuntime(
  args: Parameters<
    typeof import("../../fixtures/chat-runtime").createTestChatRuntime
  >[0],
  env: NodeJS.ProcessEnv = {},
) {
  process.env = {
    ...ORIGINAL_ENV,
    SLACK_BOT_TOKEN: "",
    SLACK_BOT_USER_TOKEN: "",
    ...env,
  };
  vi.resetModules();
  const { createTestChatRuntime } = await import("../../fixtures/chat-runtime");
  return createTestChatRuntime(args);
}

function makeSuccessReply(text = "ok") {
  return {
    text,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "test-model",
      outcome: "success" as const,
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
  };
}

function extractImageAttachmentSummary(
  promptText: string | undefined,
): string | undefined {
  if (!promptText) {
    return undefined;
  }

  const match = promptText.match(/<summary>\n([\s\S]*)\n<\/summary>/);
  return match?.[1];
}

describe("bot image hydration", () => {
  beforeEach(() => {
    listThreadRepliesMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("hydrates thread image backfill once across agent instances with shared state", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000000.100",
        files: [],
      },
    ]);

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
          },
          replyExecutor: {
            generateAssistantReply: async () => makeSuccessReply(),
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
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
                slackTs: "1700000000.100",
              },
              author: {
                userId: "U-user",
                userName: "user",
              },
            },
          ],
          compactions: [],
          backfill: {
            completedAtMs: 1700000000000,
            source: "recent_messages",
          },
          processing: {},
          stats: {
            estimatedContextTokens: 0,
            totalMessageCount: 1,
            compactedMessageCount: 0,
            updatedAtMs: 1700000000000,
          },
          vision: {
            byFileId: {},
          },
        },
      },
    });

    await slackRuntime.handleNewMention(
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
          isMe: false,
        },
      }),
    );

    const persisted = firstThread.getState();
    const secondThread = createTestThread({
      id: "slack:C_IMAGE:1700000000.000",
      state: persisted,
    });

    await slackRuntime.handleNewMention(
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
          isMe: false,
        },
      }),
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("does not hydrate thread images when AI_VISION_MODEL is unset", async () => {
    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock,
        },
        replyExecutor: {
          generateAssistantReply: async () => makeSuccessReply(),
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C_IMAGE:1700000001.000",
      state: {
        conversation: {
          schemaVersion: 1,
          messages: [],
          compactions: [],
          backfill: {
            completedAtMs: 1700000000000,
            source: "recent_messages",
          },
          processing: {},
          stats: {
            estimatedContextTokens: 0,
            totalMessageCount: 0,
            compactedMessageCount: 0,
            updatedAtMs: 1700000000000,
          },
          vision: {
            byFileId: {},
          },
        },
      },
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000001.200",
        text: "what's in this screenshot?",
        threadId: "slack:C_IMAGE:1700000001.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "screen.png",
            data: Buffer.from("fake-image"),
          },
        ],
      }),
    );

    expect(listThreadRepliesMock).not.toHaveBeenCalled();
    const persistedState = thread.getState() as {
      conversation: {
        messages: Array<{
          meta?: {
            imagesHydrated?: boolean;
          };
        }>;
        vision: {
          backfillCompletedAtMs?: number;
        };
      };
    };
    expect(
      persistedState.conversation.vision.backfillCompletedAtMs,
    ).toBeUndefined();
    expect(
      persistedState.conversation.messages.at(-1)?.meta?.imagesHydrated,
    ).not.toBe(true);
  });

  it("backfills older image messages after vision is enabled later", async () => {
    const firstRuntime = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock,
        },
        replyExecutor: {
          generateAssistantReply: async () => makeSuccessReply(),
        },
      },
    });
    const firstThread = createTestThread({
      id: "slack:C_IMAGE:1700000002.000",
      state: {
        conversation: {
          schemaVersion: 1,
          messages: [],
          compactions: [],
          backfill: {
            completedAtMs: 1700000000000,
            source: "recent_messages",
          },
          processing: {},
          stats: {
            estimatedContextTokens: 0,
            totalMessageCount: 0,
            compactedMessageCount: 0,
            updatedAtMs: 1700000000000,
          },
          vision: {
            byFileId: {},
          },
        },
      },
    });

    await firstRuntime.slackRuntime.handleNewMention(
      firstThread,
      createTestMessage({
        id: "1700000002.100",
        text: "what is in this screenshot?",
        threadId: "slack:C_IMAGE:1700000002.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "screen.png",
            data: Buffer.from("fake-image"),
          },
        ],
      }),
    );

    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000002.100",
        files: [
          {
            id: "F_OLD",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/old.png",
          },
        ],
      },
    ]);
    const downloadPrivateSlackFileMock = vi.fn(async () =>
      Buffer.from("downloaded-image"),
    );
    const completeTextMock = vi.fn(async () => ({
      text: "Recovered screenshot context",
      message: {} as never,
    }));

    const secondRuntime = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadPrivateSlackFile: downloadPrivateSlackFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            generateAssistantReply: async () => makeSuccessReply(),
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
    const secondThread = createTestThread({
      id: "slack:C_IMAGE:1700000002.000",
      state: firstThread.getState(),
    });

    await secondRuntime.slackRuntime.handleNewMention(
      secondThread,
      createTestMessage({
        id: "1700000002.200",
        text: "follow up without new uploads",
        threadId: "slack:C_IMAGE:1700000002.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
    expect(downloadPrivateSlackFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    const persistedState = secondThread.getState() as {
      conversation: {
        messages: Array<{
          id: string;
          meta?: {
            imagesHydrated?: boolean;
            imageFileIds?: string[];
          };
        }>;
        vision: {
          backfillCompletedAtMs?: number;
          byFileId: Record<string, { summary: string }>;
        };
      };
    };
    expect(
      persistedState.conversation.messages.find(
        (message) => message.id === "1700000002.100",
      )?.meta,
    ).toEqual(
      expect.objectContaining({
        imagesHydrated: true,
        imageFileIds: ["F_OLD"],
      }),
    );
    expect(persistedState.conversation.vision.byFileId.F_OLD?.summary).toBe(
      "Recovered screenshot context",
    );
    expect(persistedState.conversation.vision.backfillCompletedAtMs).toBeTypeOf(
      "number",
    );
  });

  it("hydrates skipped passive screenshots when a later explicit mention needs them", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000002.100",
        files: [
          {
            id: "F_PASSIVE",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/passive.png",
          },
        ],
      },
    ]);
    const downloadPrivateSlackFileMock = vi.fn(async () =>
      Buffer.from("downloaded-image"),
    );
    const completeTextMock = vi.fn(async () => ({
      text: "Passive screenshot summary",
      message: {} as never,
    }));
    const generateAssistantReply = vi.fn(
      async (_text: string, context: any) => {
        expect(context?.conversationContext).toContain(
          "Passive screenshot summary",
        );
        return makeSuccessReply();
      },
    );

    const { slackRuntime } = await createRuntime(
      {
        services: {
          subscribedReplyPolicy: {
            completeObject: async () => {
              throw new Error(
                "classifier should not run for messages addressed to another bot",
              );
            },
          },
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadPrivateSlackFile: downloadPrivateSlackFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            generateAssistantReply,
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
    const thread = createTestThread({
      id: "slack:C_IMAGE:1700000006.000",
      state: {
        conversation: {
          schemaVersion: 1,
          messages: [],
          compactions: [],
          backfill: {
            completedAtMs: 1700000000000,
            source: "recent_messages",
          },
          processing: {},
          stats: {
            estimatedContextTokens: 0,
            totalMessageCount: 0,
            compactedMessageCount: 0,
            updatedAtMs: 1700000000000,
          },
          vision: {
            byFileId: {},
          },
        },
      },
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "1700000002.100",
        text: "@Cursor can you look at this?",
        threadId: "slack:C_IMAGE:1700000006.000",
        isMention: false,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "passive.png",
            url: "https://files.slack.com/private/passive.png",
          },
        ],
      }),
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(listThreadRepliesMock).not.toHaveBeenCalled();

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000002.200",
        text: "<@U_APP> what is in the screenshot above?",
        threadId: "slack:C_IMAGE:1700000006.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
    expect(downloadPrivateSlackFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);

    const persistedState = thread.getState() as {
      conversation: {
        messages: Array<{
          id: string;
          meta?: {
            imagesHydrated?: boolean;
            imageFileIds?: string[];
          };
        }>;
        vision: {
          byFileId: Record<string, { summary: string }>;
        };
      };
    };
    expect(
      persistedState.conversation.messages.find(
        (message) => message.id === "1700000002.100",
      )?.meta,
    ).toEqual(
      expect.objectContaining({
        imagesHydrated: true,
        imageFileIds: ["F_PASSIVE"],
      }),
    );
    expect(persistedState.conversation.vision.byFileId.F_PASSIVE?.summary).toBe(
      "Passive screenshot summary",
    );
  });

  it("reuses the thread image summary instead of re-analyzing the same upload", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000003.100",
        files: [
          {
            id: "F_CUR",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/current.png",
          },
        ],
      },
    ]);
    const downloadPrivateSlackFileMock = vi.fn(async () =>
      Buffer.from("downloaded-image"),
    );
    const completeTextMock = vi.fn(async () => ({
      text: "Current screenshot summary",
      message: {} as never,
    }));
    const attachmentFetch = vi.fn(async () => Buffer.from("attachment-image"));
    const generateAssistantReply = vi.fn(
      async (_text: string, context: any) => {
        expect(context?.userAttachments).toEqual([
          expect.objectContaining({
            mediaType: "image/png",
            filename: "screen.png",
            promptText: expect.stringContaining("Current screenshot summary"),
          }),
        ]);
        return makeSuccessReply();
      },
    );

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadPrivateSlackFile: downloadPrivateSlackFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            generateAssistantReply,
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C_IMAGE:1700000003.000",
        state: {
          conversation: {
            schemaVersion: 1,
            messages: [],
            compactions: [],
            backfill: {
              completedAtMs: 1700000000000,
              source: "recent_messages",
            },
            processing: {},
            stats: {
              estimatedContextTokens: 0,
              totalMessageCount: 0,
              compactedMessageCount: 0,
              updatedAtMs: 1700000000000,
            },
            vision: {
              byFileId: {},
            },
          },
        },
      }),
      createTestMessage({
        id: "1700000003.100",
        text: "explain this screenshot",
        threadId: "slack:C_IMAGE:1700000003.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "screen.png",
            fetchData: attachmentFetch,
          },
        ],
      }),
    );

    expect(downloadPrivateSlackFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(attachmentFetch).not.toHaveBeenCalled();
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
  });

  it("keeps cached image summaries aligned with attachment positions", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000004.100",
        files: [
          {
            id: "F_MISSING",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/missing.png",
          },
          {
            id: "F_CACHED",
            mimetype: "image/png",
            url_private_download: "https://files.slack.com/private/cached.png",
          },
        ],
      },
    ]);
    const downloadPrivateSlackFileMock = vi.fn(async () =>
      Buffer.from("downloaded-image"),
    );
    let completeTextCallCount = 0;
    const completeTextMock = vi.fn(async () => {
      completeTextCallCount += 1;
      if (completeTextCallCount === 1) {
        return {
          text: "",
          message: {} as never,
        };
      }
      if (completeTextCallCount === 2) {
        return {
          text: "Second cached summary",
          message: {} as never,
        };
      }
      return {
        text: "First attachment summary",
        message: {} as never,
      };
    });
    const firstAttachmentFetch = vi.fn(async () => Buffer.from("first-image"));
    const secondAttachmentFetch = vi.fn(async () =>
      Buffer.from("second-image"),
    );
    const generateAssistantReply = vi.fn(
      async (_text: string, context: any) => {
        expect(context?.userAttachments).toEqual([
          expect.objectContaining({
            filename: "first.png",
            promptText: expect.stringContaining("First attachment summary"),
          }),
          expect.objectContaining({
            filename: "second.png",
            promptText: expect.stringContaining("Second cached summary"),
          }),
        ]);
        return makeSuccessReply();
      },
    );

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadPrivateSlackFile: downloadPrivateSlackFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            generateAssistantReply,
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C_IMAGE:1700000004.000",
        state: {
          conversation: {
            schemaVersion: 1,
            messages: [],
            compactions: [],
            backfill: {
              completedAtMs: 1700000000000,
              source: "recent_messages",
            },
            processing: {},
            stats: {
              estimatedContextTokens: 0,
              totalMessageCount: 0,
              compactedMessageCount: 0,
              updatedAtMs: 1700000000000,
            },
            vision: {
              byFileId: {},
            },
          },
        },
      }),
      createTestMessage({
        id: "1700000004.100",
        text: "compare these screenshots",
        threadId: "slack:C_IMAGE:1700000004.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "first.png",
            fetchData: firstAttachmentFetch,
          },
          {
            type: "image",
            mimeType: "image/png",
            name: "second.png",
            fetchData: secondAttachmentFetch,
          },
        ],
      }),
    );

    expect(downloadPrivateSlackFileMock).toHaveBeenCalledTimes(2);
    expect(completeTextMock).toHaveBeenCalledTimes(3);
    expect(firstAttachmentFetch).toHaveBeenCalledTimes(1);
    expect(secondAttachmentFetch).not.toHaveBeenCalled();
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
  });

  it("truncates inline image summaries to the cached summary limit", async () => {
    listThreadRepliesMock.mockResolvedValue([]);
    const longSummary = "A".repeat(550);
    const completeTextMock = vi.fn(async () => ({
      text: longSummary,
      message: {} as never,
    }));
    const generateAssistantReply = vi.fn(
      async (_text: string, context: any) => {
        const promptText = context?.userAttachments?.[0]?.promptText;
        const summary = extractImageAttachmentSummary(promptText);
        expect(summary).toBe(longSummary.slice(0, 500));
        expect(summary).toHaveLength(500);
        return makeSuccessReply();
      },
    );

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            generateAssistantReply,
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C_IMAGE:1700000005.000",
        state: {
          conversation: {
            schemaVersion: 1,
            messages: [],
            compactions: [],
            backfill: {
              completedAtMs: 1700000000000,
              source: "recent_messages",
            },
            processing: {},
            stats: {
              estimatedContextTokens: 0,
              totalMessageCount: 0,
              compactedMessageCount: 0,
              updatedAtMs: 1700000000000,
            },
            vision: {
              byFileId: {},
            },
          },
        },
      }),
      createTestMessage({
        id: "1700000005.100",
        text: "summarize this screenshot",
        threadId: "slack:C_IMAGE:1700000005.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            name: "long.png",
            data: Buffer.from("image-bytes"),
          },
        ],
      }),
    );

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(generateAssistantReply).toHaveBeenCalledTimes(1);
  });

  it("includes generated files in thread.post via SDK file upload", async () => {
    const generatedFile = {
      data: Buffer.from("fake-png"),
      filename: "generated.png",
      mimeType: "image/png",
    };

    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            ...makeSuccessReply("Here is your image"),
            files: [generatedFile],
          }),
        },
      },
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C_UPLOAD:1700000000.000",
      state: {},
    });
    thread.post = postSpy as unknown as Thread["post"];

    await slackRuntime.handleNewMention(
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
          isMe: false,
        },
      }),
    );

    const filePost = postSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "files" in (call[0] as Record<string, unknown>) &&
        Array.isArray((call[0] as { files?: unknown[] }).files) &&
        (call[0] as { files: unknown[] }).files.length > 0,
    );
    expect(filePost).toBeDefined();
    expect(
      (filePost![0] as { files: Array<{ filename: string }> }).files[0]
        .filename,
    ).toBe("generated.png");
  });

  it("posts files separately when streamed reply is already in progress", async () => {
    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
        },
        replyExecutor: {
          generateAssistantReply: async (_text: string, context: any) => {
            context?.onTextDelta?.("streamed ");
            context?.onTextDelta?.("content");
            return {
              ...makeSuccessReply("streamed content"),
              files: [
                {
                  data: Buffer.from("fake-png"),
                  filename: "generated.png",
                  mimeType: "image/png",
                },
              ],
            };
          },
        },
      },
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C_STREAM:1700000000.000",
      state: {},
    });
    thread.post = postSpy as unknown as Thread["post"];

    await slackRuntime.handleNewMention(
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
          isMe: false,
        },
      }),
    );

    // Should have at least 2 posts: the streamed reply and the file upload
    expect(postSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // The file follow-up post should be file-only without placeholder markdown text.
    const filePost = postSpy.mock.calls.find(
      (call: unknown[]) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "files" in (call[0] as Record<string, unknown>) &&
        Array.isArray((call[0] as { files?: unknown[] }).files) &&
        (call[0] as { files: unknown[] }).files.length > 0,
    );
    expect(filePost).toBeDefined();
    const filePostArg = filePost![0] as Record<string, unknown>;
    expect(filePostArg).toHaveProperty("raw", "");
    expect(filePostArg).not.toHaveProperty("markdown");
    expect((filePostArg.files as Array<{ filename: string }>)[0].filename).toBe(
      "generated.png",
    );
  });
});
