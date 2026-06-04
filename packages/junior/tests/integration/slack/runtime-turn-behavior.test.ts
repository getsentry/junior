import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { getSlackInterruptionMarker } from "@/chat/slack/output";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  FakeSlackAdapter,
  createTestThread,
  createTestMessage,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";

const emptyThreadReplies = async () => [];

function postIncludes(thread: { posts: unknown[] }, text: string): boolean {
  return thread.posts.some((post) => {
    if (typeof post === "string") {
      return post.includes(text);
    }
    if (
      post &&
      typeof post === "object" &&
      "markdown" in (post as Record<string, unknown>)
    ) {
      return String((post as { markdown: string }).markdown).includes(text);
    }
    return false;
  });
}

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

function createAwaitingContinuationState(args: {
  activeSessionId: string;
  replied?: boolean;
  userMessageId?: string;
  userText?: string;
}) {
  return {
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
          id: args.userMessageId ?? "msg-original",
          role: "user",
          text: args.userText ?? "please keep working",
          createdAtMs: 1,
          author: {
            userId: "U-test",
          },
          ...(args.replied === undefined
            ? {}
            : { meta: { replied: args.replied } }),
        },
      ],
      processing: {
        activeTurnId: args.activeSessionId,
      },
      stats: {
        compactedMessageCount: 0,
        estimatedContextTokens: 0,
        totalMessageCount: 1,
        updatedAtMs: 1,
      },
      vision: {
        byFileId: {},
      },
    },
  };
}

function turnPiMessages(text: string) {
  return [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text }],
      timestamp: 1,
    },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────

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

  it("error recovery: posts safe error message when generateAssistantReply throws", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new Error("LLM unavailable");
          },
        },
        visionContext: {
          listThreadReplies: async () => [],
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
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: finalText,
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "fake-agent-model",
              outcome: "success",
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
        visionContext: {
          listThreadReplies: async () => [],
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
            return {
              text: "Done.",
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

  it("parks MCP auth resume turns without rethrowing to the queue", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new RetryableTurnError(
              "mcp_auth_resume",
              "simulated auth pause",
              {
                authDisposition: "link_sent",
                authKind: "mcp",
                authProvider: "notion",
                authProviderDisplayName: "Notion",
              },
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_AUTH:1700000000.000" });
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-auth-pause",
          threadId: "slack:C_AUTH:1700000000.000",
          text: "please use notion",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining(
          "<@U-test> I'll need you to authorize Notion. I sent you a link.",
        ),
      }),
    ]);
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
            role?: string;
            text?: string;
          }>;
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
    expect(conversation?.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: expect.stringContaining("authorize Notion"),
        }),
      ]),
    );
    expect(
      conversation?.messages?.find(
        (message) => message.id === "msg-auth-pause",
      ),
    ).toMatchObject({
      meta: {
        replied: true,
        skippedReason: undefined,
      },
    });
  });

  it("parks plugin auth resume turns without rethrowing to the queue", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            throw new RetryableTurnError(
              "plugin_auth_resume",
              "simulated plugin auth pause",
              {
                authDisposition: "link_sent",
                authKind: "plugin",
                authProvider: "github",
                authProviderDisplayName: "GitHub",
              },
            );
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_PLUGIN_AUTH:1700000000.000",
    });
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-plugin-auth-pause",
          threadId: "slack:C_PLUGIN_AUTH:1700000000.000",
          text: "please use github",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining(
          "<@U-test> I'll need you to authorize GitHub. I sent you a link.",
        ),
      }),
    ]);
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
            role?: string;
            text?: string;
          }>;
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
    expect(conversation?.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: expect.stringContaining("authorize GitHub"),
        }),
      ]),
    );
    expect(
      conversation?.messages?.find(
        (message) => message.id === "msg-plugin-auth-pause",
      ),
    ).toMatchObject({
      meta: {
        replied: true,
        skippedReason: undefined,
      },
    });
  });

  it("schedules durable continuation without posting a notice", async () => {
    const scheduleTurnTimeoutResume = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C_TIMEOUT:1700000000.000";
    const sessionId = "turn_msg-timeout";
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          scheduleAgentContinue,
          generateAssistantReply: async () => {
            throw new RetryableTurnError(
              "agent_continue",
              "simulated timeout continuation",
              {
                conversationId,
                sessionId,
                version: 3,
                sliceId: 2,
              },
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: conversationId });
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-timeout",
          threadId: conversationId,
          text: "please keep working",
          isMention: true,
        }),
      ),
    ).resolves.toBeUndefined();

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      sessionId,
      expectedVersion: 3,
    });
    expect(thread.posts).toEqual([]);

    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe(sessionId);
  });

  it("reschedules an awaiting turn continuation without replying to the follow-up", async () => {
    const conversationId = "slack:C_TIMEOUT_RETRY:1700000000.000";
    const activeSessionId = "turn_msg-original";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const onInputCommitted = vi.fn();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
          getAwaitingAgentContinueRequest,
          scheduleAgentContinue,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-retry",
          threadId: conversationId,
          text: "what happened?",
          isMention: true,
        }),
        { onInputCommitted, onTurnStatePersisted },
      ),
    ).resolves.toBeUndefined();

    expect(getAwaitingAgentContinueRequest).toHaveBeenCalledWith({
      conversationId,
      sessionId: activeSessionId,
    });
    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(onInputCommitted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);

    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
          }>;
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe(activeSessionId);
    const followUp = conversation?.messages?.find(
      (message) => message.id === "msg-retry",
    );
    expect(followUp).toBeDefined();
    expect(followUp?.meta?.replied).toBeUndefined();
    expect(followUp?.meta?.skippedReason).toBeUndefined();
  });

  it("parks auth-paused active turns without starting a new follow-up turn", async () => {
    const conversationId = "slack:C_AUTH_PARKED:1700000000.000";
    const activeSessionId = "turn_msg-auth-original";
    const generateAssistantReply = vi.fn();
    const onTurnStatePersisted = vi.fn();
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "auth",
      piMessages: turnPiMessages("please use notion"),
    });
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-auth-follow-up",
        threadId: conversationId,
        text: "any update?",
        isMention: true,
      }),
      { onTurnStatePersisted },
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          messages?: Array<{
            id?: string;
            meta?: { replied?: boolean; skippedReason?: string };
          }>;
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe(activeSessionId);
    const followUp = conversation?.messages?.find(
      (message) => message.id === "msg-auth-follow-up",
    );
    expect(followUp).toBeDefined();
    expect(followUp?.meta?.replied).toBeUndefined();
    expect(followUp?.meta?.skippedReason).toBeUndefined();
  });

  it("fails malformed awaiting continuations before handling the follow-up", async () => {
    const conversationId = "slack:C_BAD_CONTINUATION:1700000000.000";
    const activeSessionId = "turn_msg-timeout-original";
    const generateAssistantReply = vi.fn().mockResolvedValue({
      text: "Recovered.",
      diagnostics: {
        assistantMessageCount: 1,
        modelId: "test-model",
        outcome: "success" as const,
        toolCalls: [],
        toolErrorCount: 0,
        toolResultCount: 0,
        usedPrimaryText: true,
      },
    });
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "timeout",
      piMessages: turnPiMessages("please keep working"),
    });
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-timeout-follow-up",
        threadId: conversationId,
        text: "what happened?",
        isMention: true,
      }),
    );

    expect(generateAssistantReply).toHaveBeenCalledOnce();
    expect(postIncludes(thread, "Recovered.")).toBe(true);
    const failedRecord = await getAgentTurnSessionRecord(
      conversationId,
      activeSessionId,
    );
    expect(failedRecord?.state).toBe("failed");
    expect(failedRecord?.errorMessage).toBe(
      "Awaiting agent continuation metadata could not be materialized",
    );
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: { processing?: { activeTurnId?: string } };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
  });

  it("reschedules an awaiting continuation for repeated delivery of the active message", async () => {
    const conversationId = "slack:C_TIMEOUT_DUPLICATE:1700000000.000";
    const activeSessionId = "turn_msg-duplicate";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
          getAwaitingAgentContinueRequest,
          scheduleAgentContinue,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({
        activeSessionId,
        userMessageId: "msg-duplicate",
      }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-duplicate",
        threadId: conversationId,
        text: "please keep working",
        isMention: true,
      }),
    );

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    expect(generateAssistantReply).not.toHaveBeenCalled();
  });

  it("does not reschedule an awaiting continuation for an already-replied duplicate", async () => {
    const conversationId = "slack:C_TIMEOUT_REPLIED_DUP:1700000000.000";
    const activeSessionId = "turn_msg-replied-duplicate";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
          getAwaitingAgentContinueRequest,
          scheduleAgentContinue,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({
        activeSessionId,
        replied: true,
        userMessageId: "msg-replied-duplicate",
      }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-replied-duplicate",
        threadId: conversationId,
        text: "please keep working",
        isMention: true,
      }),
      { onTurnStatePersisted },
    );

    expect(getAwaitingAgentContinueRequest).not.toHaveBeenCalled();
    expect(scheduleAgentContinue).not.toHaveBeenCalled();
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
  });

  it("keeps awaiting continuation state without a visible acknowledgement", async () => {
    const conversationId = "slack:C_TIMEOUT_NOTICE_FAIL:1700000000.000";
    const activeSessionId = "turn_msg-original";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
          getAwaitingAgentContinueRequest,
          scheduleAgentContinue,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-retry-notice-fail",
        threadId: conversationId,
        text: "what happened?",
        isMention: true,
      }),
    );

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([]);

    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: {
          processing?: { activeTurnId?: string };
        };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBe(activeSessionId);
  });

  it("does not start a new turn when rescheduling an active continuation fails", async () => {
    const conversationId = "slack:C_TIMEOUT_RETRY_FAIL:1700000000.000";
    const activeSessionId = "turn_msg-original";
    const scheduleAgentContinue = vi
      .fn()
      .mockRejectedValue(new Error("resume callback unavailable"));
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    const generateAssistantReply = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply,
          getAwaitingAgentContinueRequest,
          scheduleAgentContinue,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-retry-fail",
        threadId: conversationId,
        text: "what happened?",
        isMention: true,
      }),
    );

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });

  it("posts an interruption marker on the finalized provider-error reply", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onTextDelta?.("Partial output...");
            return {
              text: "Partial output...",
              diagnostics: {
                assistantMessageCount: 1,
                modelId: "test-model",
                outcome: "provider_error" as const,
                toolCalls: [],
                toolErrorCount: 0,
                toolResultCount: 0,
                usedPrimaryText: true,
              },
            };
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_STREAM_FAIL:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-stream-fail",
        threadId: "slack:C_STREAM_FAIL:1700000000.000",
        text: "do work",
        isMention: true,
      }),
    );

    expect(thread.posts).toHaveLength(1);
    const postText =
      typeof thread.posts[0] === "string"
        ? thread.posts[0]
        : ((thread.posts[0] as { markdown?: string }).markdown ?? "");
    expect(postText).toContain("Partial output...");
    expect(postText).toContain(getSlackInterruptionMarker().trim());
    expect(postText).not.toContain("event_id=");
  });

  it("new mention first turn has no conversation context without prior thread messages", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return {
              text: "First reply.",
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
          },
        },
      },
    });

    const threadId = "slack:C_FIRST_EMPTY:1700000000.000";
    const thread = createTestThread({ id: threadId });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-first-current",
        threadId,
        text: "Can you summarize this?",
        isMention: true,
      }),
    );

    expect(capturedContexts).toEqual([undefined]);
  });

  it("new mention first turn uses pre-existing thread transcript without the current message", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return {
              text: "Follow-up reply.",
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
          },
        },
      },
    });

    const threadId = "slack:C_FIRST_EXISTING:1700000000.000";
    const thread = createTestThread({ id: threadId });
    const priorMessage = createTestMessage({
      id: "msg-first-prior",
      threadId,
      text: "Original production issue summary.",
      author: { userId: "U-prior", userName: "alice", isBot: false },
    });
    priorMessage.metadata.dateSent = new Date(1_700_000_000_000);
    const currentMessage = createTestMessage({
      id: "msg-first-current",
      threadId,
      text: "Can you include the regression window?",
      isMention: true,
      author: { userId: "U-current", userName: "bob", isBot: false },
    });
    currentMessage.metadata.dateSent = new Date(1_700_000_001_000);
    thread.recentMessages = [priorMessage, currentMessage];

    await slackRuntime.handleNewMention(thread, currentMessage);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toContain("<thread-transcript>");
    expect(capturedContexts[0]).toContain("Original production issue summary.");
    expect(capturedContexts[0]).not.toContain(
      "Can you include the regression window?",
    );
  });

  it("subscribed message: does not include newer thread messages in turn context", async () => {
    const capturedContexts: Array<string | undefined> = [];
    const { slackRuntime } = createRuntime({
      services: {
        conversationMemory: {
          completeText: async () => ({ text: "Context thread" }) as never,
        },
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "follow-up",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"follow-up"}',
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            capturedContexts.push(context?.conversationContext);
            return {
              text: "Responding to first message only.",
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
          },
        },
      },
    });

    const threadId = "slack:D_ORDER:1700000000.000";
    const thread = createTestThread({ id: threadId });
    const firstMessage = createTestMessage({
      id: "1700000000.100",
      threadId,
      text: "you work now?",
      isMention: false,
    });
    const laterMessage = createTestMessage({
      id: "1700000000.200",
      threadId,
      text: "hello",
      isMention: false,
    });

    Object.defineProperty(thread, "messages", {
      configurable: true,
      get() {
        return (async function* () {
          // Chat SDK thread iterators are newest-first.
          yield laterMessage;
          yield firstMessage;
        })();
      },
    });

    await slackRuntime.handleSubscribedMessage(thread, firstMessage);

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toBeUndefined();
  });

  it("multi-turn state continuity: second turn sees first turn's conversation state", async () => {
    let turnCount = 0;
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => {
            turnCount += 1;
            return {
              text: `reply-${turnCount}`,
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
          },
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_MULTI:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t1",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "first turn",
        isMention: true,
      }),
    );

    const stateAfterFirstTurn = thread.getState();
    const conv1 = (
      stateAfterFirstTurn as { conversation?: { messages?: unknown[] } }
    ).conversation;
    expect(conv1).toBeDefined();
    const messageCountAfterFirst = conv1?.messages?.length ?? 0;

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2",
        threadId: "slack:C_MULTI:1700000000.000",
        text: "second turn",
        isMention: true,
      }),
    );

    const stateAfterSecondTurn = thread.getState();
    const conv2 = (
      stateAfterSecondTurn as { conversation?: { messages?: unknown[] } }
    ).conversation;
    expect(conv2).toBeDefined();
    expect(conv2?.messages?.length ?? 0).toBeGreaterThan(
      messageCountAfterFirst,
    );
  });
});
