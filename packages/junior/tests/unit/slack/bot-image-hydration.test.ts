import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Thread } from "chat";
import {
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";

const listThreadRepliesMock = vi.fn();

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

describe("bot image hydration", () => {
  beforeEach(() => {
    listThreadRepliesMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates thread image backfill once across agent instances with shared state", async () => {
    listThreadRepliesMock.mockResolvedValue([
      {
        ts: "1700000000.100",
        files: [],
      },
    ]);

    const { slackRuntime } = createTestChatRuntime({
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
  });

  it("includes generated files in thread.post via SDK file upload", async () => {
    const generatedFile = {
      data: Buffer.from("fake-png"),
      filename: "generated.png",
      mimeType: "image/png",
    };

    const { slackRuntime } = createTestChatRuntime({
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
    const { slackRuntime } = createTestChatRuntime({
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
