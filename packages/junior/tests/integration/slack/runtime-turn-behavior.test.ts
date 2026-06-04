import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { successfulAssistantReply } from "../../fixtures/assistant-reply";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import {
  FakeSlackAdapter,
  createTestMessage,
  createTestThread,
} from "../../fixtures/slack-harness";

const emptyThreadReplies = async () => [];

function createRuntime(
  args: {
    services?: JuniorRuntimeServiceOverrides;
    slackAdapter?: FakeSlackAdapter;
  } = {},
) {
  const services = args.services ?? {};
  return createTestChatRuntime({
    slackAdapter: args.slackAdapter,
    services: {
      ...services,
      visionContext: {
        listThreadReplies: emptyThreadReplies,
        ...(services.visionContext ?? {}),
      },
    },
  });
}

describe("Slack behavior: runtime turns", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("does not replay a message that already has a delivered reply", async () => {
    const conversationId = "slack:C_REPLAY:1700000000.000";
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });
    const thread = createTestThread({
      id: conversationId,
      state: {
        conversation: {
          schemaVersion: 1,
          backfill: {
            completedAtMs: 1,
            source: "recent_messages",
          },
          compactions: [],
          piMessages: [],
          messages: [
            {
              id: "msg-replayed",
              role: "user",
              text: "please answer once",
              createdAtMs: 1,
              author: {
                userId: "U-test",
              },
              meta: {
                replied: true,
                slackTs: "1700000000.000",
              },
            },
            {
              id: "assistant-reply",
              role: "assistant",
              text: "Already answered.",
              createdAtMs: 2,
              author: {
                isBot: true,
                userName: "Junior",
              },
              meta: {
                replied: true,
              },
            },
          ],
          processing: {},
          stats: {
            compactedMessageCount: 0,
            estimatedContextTokens: 0,
            totalMessageCount: 2,
            updatedAtMs: 2,
          },
          vision: {
            byFileId: {},
          },
        },
      },
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-replayed",
          threadId: conversationId,
          text: "please answer once",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([]);
  });

  it("posts a safe error message when assistant reply generation throws", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("LLM unavailable");
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_ERR:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-err",
        threadId: "slack:C_ERR:1700000000.000",
        text: "trigger an error",
        isMention: true,
      }),
    );

    const errorPost = thread.posts.find(
      (p) =>
        typeof p === "string" &&
        p.includes("I ran into an internal error while processing that."),
    );
    expect(errorPost).toBeDefined();
    expect(String(errorPost)).not.toContain("LLM unavailable");
  });

  it("does not persist an assistant message when final Slack delivery fails", async () => {
    const finalText = "This reply never reaches Slack.";
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () =>
            successfulAssistantReply(finalText),
        },
      },
    });
    const thread = createTestThread({
      id: "slack:C_DELIVERY_FAIL:1700000000.000",
    });
    thread.post = vi.fn(async () => {
      throw new Error("Slack unavailable");
    }) as typeof thread.post;

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-delivery-fail",
          threadId: "slack:C_DELIVERY_FAIL:1700000000.000",
          text: "please answer",
          isMention: true,
        }),
      ),
    ).rejects.toThrow("Slack unavailable");

    const conversation = (
      thread.getState() as {
        conversation?: {
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
            role?: string;
            text?: string;
          }>;
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
    expect(conversation?.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: finalText,
        }),
      ]),
    );
    expect(
      conversation?.messages?.find(
        (message) => message.id === "msg-delivery-fail",
      ),
    ).toMatchObject({
      meta: {
        replied: false,
        skippedReason: "reply failed",
      },
    });
  });

  it("passes conversation and turn correlation IDs into assistant reply context", async () => {
    const capturedCorrelation: Array<{
      conversationId?: string;
      threadId?: string;
      turnId?: string;
      runId?: string;
    }> = [];
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedCorrelation.push({
              conversationId: context?.correlation?.conversationId,
              threadId: context?.correlation?.threadId,
              turnId: context?.correlation?.turnId,
              runId: context?.correlation?.runId,
            });
            return successfulAssistantReply("Done.");
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_CORRELATION:1700000000.000",
      runId: "run-123",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-correlation",
        threadId: "slack:C_CORRELATION:1700000000.000",
        text: "trace this turn",
        isMention: true,
      }),
    );

    expect(capturedCorrelation).toHaveLength(1);
    expect(capturedCorrelation[0]).toEqual(
      expect.objectContaining({
        conversationId: "slack:C_CORRELATION:1700000000.000",
        threadId: "slack:C_CORRELATION:1700000000.000",
        runId: "run-123",
      }),
    );
    expect(capturedCorrelation[0].turnId).toBe("turn_msg-correlation");
  });
});
