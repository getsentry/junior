import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "chat";
import {
  createTestMessage,
  createTestThread,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

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
    AI_VISION_MODEL: "",
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

function makeSuccessOutcome(text = "ok") {
  return completedAgentRun(makeSuccessReply(text));
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
            agentRunner: { run: async () => makeSuccessOutcome() },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
    const firstThread = createTestThread({
      id: "slack:C0IMAGE:1700000000.000",
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
        threadId: "slack:C0IMAGE:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
      { destination: createTestDestination(firstThread) },
    );

    const persisted = firstThread.getState();
    const secondThread = createTestThread({
      id: "slack:C0IMAGE:1700000000.000",
      state: persisted,
    });

    await slackRuntime.handleNewMention(
      secondThread,
      createTestMessage({
        id: "1700000000.300",
        text: "follow up without new images",
        threadId: "slack:C0IMAGE:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
      { destination: createTestDestination(secondThread) },
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("does not hydrate thread images when AI_VISION_MODEL is unset", async () => {
    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock,
        },
        replyExecutor: {
          agentRunner: { run: async () => makeSuccessOutcome() },
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C0IMAGE:1700000001.000",
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
        text: "",
        threadId: "slack:C0IMAGE:1700000001.000",
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
      { destination: createTestDestination(thread) },
    );

    expect(listThreadRepliesMock).not.toHaveBeenCalled();
    const persistedState = thread.getState() as {
      conversation: {
        messages: Array<{
          author?: {
            isBot?: boolean;
          };
          text: string;
          meta?: {
            attachmentCount?: number;
            imageAttachmentCount?: number;
            imagesHydrated?: boolean;
            slackTs?: string;
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
    const persistedMessage = persistedState.conversation.messages.find(
      (entry) => entry.meta?.slackTs === "1700000001.200",
    );
    expect(persistedMessage).toMatchObject({
      author: {
        isBot: false,
      },
      text: "[non-text message]",
      meta: {
        attachmentCount: 1,
        imageAttachmentCount: 1,
        imagesHydrated: false,
        slackTs: "1700000001.200",
      },
    });
  }, 20_000);

  it("backfills older image messages after vision is enabled later", async () => {
    const firstRuntime = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock,
        },
        replyExecutor: {
          agentRunner: { run: async () => makeSuccessOutcome() },
        },
      },
    });
    const firstThread = createTestThread({
      id: "slack:C0IMAGE:1700000002.000",
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
        threadId: "slack:C0IMAGE:1700000002.000",
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
      { destination: createTestDestination(firstThread) },
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
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    const completeTextMock = vi.fn(async () => ({
      text: "Recovered screenshot context",
      message: {} as never,
    }));

    const secondRuntime = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadFile: downloadFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            agentRunner: { run: async () => makeSuccessOutcome() },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
    const secondThread = createTestThread({
      id: "slack:C0IMAGE:1700000002.000",
      state: firstThread.getState(),
    });

    await secondRuntime.slackRuntime.handleNewMention(
      secondThread,
      createTestMessage({
        id: "1700000002.200",
        text: "follow up without new uploads",
        threadId: "slack:C0IMAGE:1700000002.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
      { destination: createTestDestination(secondThread) },
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
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
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    const completeTextMock = vi.fn(async () => ({
      text: "Passive screenshot summary",
      message: {} as never,
    }));
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      expect(context?.conversationContext).toContain(
        "Passive screenshot summary",
      );
      return makeSuccessOutcome();
    });

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
            downloadFile: downloadFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            agentRunner: { run: executeAgentRun },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );
    const thread = createTestThread({
      id: "slack:C0IMAGE:1700000006.000",
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
        threadId: "slack:C0IMAGE:1700000006.000",
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
      { destination: createTestDestination(thread) },
    );

    expect(executeAgentRun).not.toHaveBeenCalled();
    expect(listThreadRepliesMock).not.toHaveBeenCalled();

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000002.200",
        text: "<@U0APP> what is in the screenshot above?",
        threadId: "slack:C0IMAGE:1700000006.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(listThreadRepliesMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(executeAgentRun).toHaveBeenCalledTimes(1);

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
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
    const completeTextMock = vi.fn(async () => ({
      text: "Current screenshot summary",
      message: {} as never,
    }));
    const attachmentFetch = vi.fn(async () => Buffer.from("attachment-image"));
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      expect(context?.userAttachments).toEqual([
        expect.objectContaining({
          mediaType: "image/png",
          filename: "screen.png",
          promptText: expect.stringContaining("Current screenshot summary"),
        }),
      ]);
      return makeSuccessOutcome();
    });

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadFile: downloadFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            agentRunner: { run: executeAgentRun },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C0IMAGE:1700000003.000",
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
        threadId: "slack:C0IMAGE:1700000003.000",
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
      {
        destination: createTestDestination(
          createTestThread({
            id: "slack:C0IMAGE:1700000003.000",
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
        ),
      },
    );

    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(attachmentFetch).not.toHaveBeenCalled();
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
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
    const downloadFileMock = vi.fn(async () => Buffer.from("downloaded-image"));
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
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
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
      return makeSuccessOutcome();
    });

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            downloadFile: downloadFileMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            agentRunner: { run: executeAgentRun },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C0IMAGE:1700000004.000",
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
        threadId: "slack:C0IMAGE:1700000004.000",
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
      {
        destination: createTestDestination(
          createTestThread({
            id: "slack:C0IMAGE:1700000004.000",
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
        ),
      },
    );

    expect(downloadFileMock).toHaveBeenCalledTimes(2);
    expect(completeTextMock).toHaveBeenCalledTimes(3);
    expect(firstAttachmentFetch).toHaveBeenCalledTimes(1);
    expect(secondAttachmentFetch).not.toHaveBeenCalled();
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
  });

  it("truncates inline image summaries to the cached summary limit", async () => {
    listThreadRepliesMock.mockResolvedValue([]);
    const longSummary = "A".repeat(550);
    const completeTextMock = vi.fn(async () => ({
      text: longSummary,
      message: {} as never,
    }));
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      const promptText = context?.userAttachments?.[0]?.promptText;
      const summary = extractImageAttachmentSummary(promptText);
      expect(summary).toBe(longSummary.slice(0, 500));
      expect(summary).toHaveLength(500);
      return makeSuccessOutcome();
    });

    const { slackRuntime } = await createRuntime(
      {
        services: {
          visionContext: {
            listThreadReplies: listThreadRepliesMock,
            completeText: completeTextMock,
          },
          replyExecutor: {
            agentRunner: { run: executeAgentRun },
          },
        },
      },
      {
        AI_VISION_MODEL: "openai/gpt-5.4",
      },
    );

    await slackRuntime.handleNewMention(
      createTestThread({
        id: "slack:C0IMAGE:1700000005.000",
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
        threadId: "slack:C0IMAGE:1700000005.000",
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
      {
        destination: createTestDestination(
          createTestThread({
            id: "slack:C0IMAGE:1700000005.000",
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
        ),
      },
    );

    expect(completeTextMock).toHaveBeenCalledTimes(1);
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
                ...makeSuccessReply("Here is your image"),
                files: [generatedFile],
              }),
          },
        },
      },
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C0UPLOAD:1700000000.000",
      state: {},
    });
    thread.post = postSpy as unknown as Thread["post"];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000000.200",
        text: "generate an image",
        threadId: "slack:C0UPLOAD:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
      { destination: createTestDestination(thread) },
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

  it("attaches files inline on the finalized reply post", async () => {
    const { slackRuntime } = await createRuntime({
      services: {
        visionContext: {
          listThreadReplies: listThreadRepliesMock.mockResolvedValue([]),
        },
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _text = request.input.messageText;
              const _context = {
                ...flattenAgentRunRequestForTest(request),
              };

              return completedAgentRun({
                ...makeSuccessReply("finalized content"),
                files: [
                  {
                    data: Buffer.from("fake-png"),
                    filename: "generated.png",
                    mimeType: "image/png",
                  },
                ],
              });
            },
          },
        },
      },
    });

    const postSpy = vi.fn().mockResolvedValue(undefined);
    const thread = createTestThread({
      id: "slack:C0STREAM:1700000000.000",
      state: {},
    });
    thread.post = postSpy as unknown as Thread["post"];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "1700000000.200",
        text: "generate an image",
        threadId: "slack:C0STREAM:1700000000.000",
        isMention: true,
        author: {
          userId: "U-user",
          userName: "user",
          fullName: "User Example",
          isBot: false,
          isMe: false,
        },
      }),
      { destination: createTestDestination(thread) },
    );

    expect(postSpy.mock.calls).toHaveLength(1);

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
    expect(filePostArg).toHaveProperty("markdown", "finalized content");
    expect((filePostArg.files as Array<{ filename: string }>)[0].filename).toBe(
      "generated.png",
    );
  });
});
