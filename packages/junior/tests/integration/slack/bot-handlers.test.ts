import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "@sentry/junior-plugin-api";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import type { ReplyRequestContext } from "@/chat/respond";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import { getSlackInterruptionMarker } from "@/chat/slack/output";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import {
  FakeSlackAdapter,
  createTestThread,
  createTestMessage,
  createTestDestination,
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

function slackDestination(channelId: string) {
  return {
    platform: "slack",
    teamId: "T123",
    channelId,
  } satisfies Destination;
}

function rawSlackMessage(
  conversationId: string,
  destination: Destination,
): Record<string, unknown> {
  if (destination.platform !== "slack") {
    throw new Error("Expected Slack destination");
  }
  const [, , threadTs = "1700000000.000"] = conversationId.split(":");
  return {
    channel: destination.channelId,
    team_id: destination.teamId,
    ts: threadTs,
    thread_ts: threadTs,
  };
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

describe("bot handlers (integration)", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    resetSlackApiMockState();
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("handleNewMention: posts reply from generateAssistantReply", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Hello from the bot!",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
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

    const thread = createTestThread({ id: "slack:C_INT:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-new-mention",
        threadId: "slack:C_INT:1700000000.000",
        text: "hey bot",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts.length).toBeGreaterThan(0);
    const hasReply = thread.posts.some((p) => {
      if (typeof p === "string") return p.includes("Hello from the bot!");
      if (
        p &&
        typeof p === "object" &&
        "markdown" in (p as Record<string, unknown>)
      ) {
        return String((p as { markdown: string }).markdown).includes(
          "Hello from the bot!",
        );
      }
      return false;
    });
    expect(hasReply).toBe(true);
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
        { destination: createTestDestination(thread) },
      ),
    ).resolves.toBeUndefined();

    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([]);
  });

  it("handleSubscribedMessage with explicit mention: replies when should_reply is true", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: true,
                confidence: 1,
                reason: "explicit mention",
              },
              text: '{"should_reply":true,"confidence":1,"reason":"explicit mention"}',
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Replying to mention",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
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

    const thread = createTestThread({ id: "slack:C_SUB:1700000000.000" });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-mention",
        threadId: "slack:C_SUB:1700000000.000",
        text: "<@UBOT> check this",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.posts.length).toBeGreaterThan(0);
  });

  it("handleSubscribedMessage skip: does not reply when should_reply is false", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        subscribedReplyPolicy: {
          completeObject: async () =>
            ({
              object: {
                should_reply: false,
                confidence: 0,
                reason: "passive conversation",
              },
              text: '{"should_reply":false,"confidence":0,"reason":"passive conversation"}',
            }) as any,
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = createTestThread({ id: "slack:C_SKIP:1700000000.000" });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-skip",
        threadId: "slack:C_SKIP:1700000000.000",
        text: "just chatting among ourselves",
      }),
      { destination: createTestDestination(thread) },
    );

    // Should not have posted a reply (no generateAssistantReply call)
    const hasReply = thread.posts.some((p) => {
      if (typeof p === "string") return !p.startsWith("Error:");
      if (
        p &&
        typeof p === "object" &&
        "markdown" in (p as Record<string, unknown>)
      )
        return true;
      return false;
    });
    expect(hasReply).toBe(false);

    // Verify state was persisted with replied: false
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: { messages?: Array<{ meta?: { replied?: boolean } }> };
      }
    ).conversation;
    const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
    expect(lastMsg?.meta?.replied).toBe(false);
  });

  it("handleAssistantThreadStarted: sets title and suggested prompts via adapter", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter: fakeAdapter,
    });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: "slack:C_ASSIST:1700000000.000",
      channelId: "C_ASSIST",
      threadTs: "1700000000.000",
      userId: "U-starter",
    });

    expect(fakeAdapter.titleCalls.length).toBe(1);
    expect(fakeAdapter.titleCalls[0].title).toBe("Junior");
    expect(fakeAdapter.titleCalls[0].channelId).toBe("C_ASSIST");
    expect(fakeAdapter.promptCalls.length).toBe(1);
    expect(fakeAdapter.promptCalls[0].prompts.length).toBe(3);
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
      { destination: createTestDestination(thread) },
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
        { destination: createTestDestination(thread) },
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
      { destination: createTestDestination(thread) },
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
        { destination: createTestDestination(thread) },
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("private link"),
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
          text: expect.stringContaining("private link"),
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
        { destination: createTestDestination(thread) },
      ),
    ).resolves.toBeUndefined();

    expect(thread.posts).toEqual([
      expect.objectContaining({
        markdown: expect.stringContaining("private link"),
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
          text: expect.stringContaining("private link"),
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
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C9TIMEOUT:1700000000.000";
    const destination = slackDestination("C9TIMEOUT");
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
          raw: rawSlackMessage(conversationId, destination),
        }),
        { destination },
      ),
    ).resolves.toBeUndefined();

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
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

  it("schedules agent continuations with the provided destination", async () => {
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C9TIMECTX:1700000000.000";
    const destination = slackDestination("C9TIMECTX");
    const sessionId = "turn_msg-timeout-context";
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
                version: 4,
                sliceId: 2,
              },
            );
          },
        },
      },
    });

    const thread = createTestThread({ id: conversationId });
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-timeout-context",
        threadId: conversationId,
        text: "please keep working",
        isMention: true,
        raw: rawSlackMessage(conversationId, {
          ...destination,
          teamId: "TWRONG",
        }),
      }),
      {
        destination,
      },
    );

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId,
      expectedVersion: 4,
    });
  });

  it("does not post a Slack continuation notice when a live turn times out", async () => {
    resetSlackApiMockState();
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C9TIMEAPI:1700000000.000";
    const destination = slackDestination("C9TIMEAPI");
    const sessionId = "turn_msg-timeout-api";
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
    (thread.adapter as { name?: string }).name = "slack";

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-timeout-api",
          threadId: conversationId,
          text: "please keep working",
          isMention: true,
          raw: rawSlackMessage(conversationId, destination),
        }),
        { destination },
      ),
    ).resolves.toBeUndefined();

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId,
      expectedVersion: 3,
    });
    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([]);
  });

  it("reschedules an awaiting agent continuation without replying to the follow-up", async () => {
    const conversationId = "slack:C9TIMERTY:1700000000.000";
    const destination = slackDestination("C9TIMERTY");
    const activeSessionId = "turn_msg-original";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
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
        {
          destination,
          onInputCommitted,
          onTurnStatePersisted,
        },
      ),
    ).resolves.toBeUndefined();

    expect(getAwaitingAgentContinueRequest).toHaveBeenCalledWith({
      conversationId,
      sessionId: activeSessionId,
    });
    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
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
      {
        destination: createTestDestination(thread),
        onTurnStatePersisted,
      },
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
      { destination: createTestDestination(thread) },
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
    const conversationId = "slack:C9TIMEDUP:1700000000.000";
    const destination = slackDestination("C9TIMEDUP");
    const activeSessionId = "turn_msg-duplicate";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
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
      { destination },
    );

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId: activeSessionId,
      expectedVersion: 4,
    });
    expect(generateAssistantReply).not.toHaveBeenCalled();
  });

  it("does not reschedule an awaiting continuation for an already-replied duplicate", async () => {
    const conversationId = "slack:C9TIMEREPD:1700000000.000";
    const destination = slackDestination("C9TIMEREPD");
    const activeSessionId = "turn_msg-replied-duplicate";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
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
      {
        destination,
        onTurnStatePersisted,
      },
    );

    expect(getAwaitingAgentContinueRequest).not.toHaveBeenCalled();
    expect(scheduleAgentContinue).not.toHaveBeenCalled();
    expect(generateAssistantReply).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
  });

  it("keeps awaiting continuation state without a visible acknowledgement", async () => {
    const conversationId = "slack:C9TIMENOTI:1700000000.000";
    const destination = slackDestination("C9TIMENOTI");
    const activeSessionId = "turn_msg-original";
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
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
      { destination },
    );

    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
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
    const conversationId = "slack:C9TIMEFAIL:1700000000.000";
    const destination = slackDestination("C9TIMEFAIL");
    const activeSessionId = "turn_msg-original";
    const scheduleAgentContinue = vi
      .fn()
      .mockRejectedValue(new Error("resume callback unavailable"));
    const getAwaitingAgentContinueRequest = vi.fn().mockResolvedValue({
      conversationId,
      destination,
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
      { destination },
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
      { destination: createTestDestination(thread) },
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

  it("emits assistant status updates in shared channel threads", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          generateAssistantReply: async (_prompt, context) => {
            await context?.onStatus?.(
              makeAssistantStatus("reading", "channel messages"),
            );
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

    const thread = createTestThread({ id: "slack:C_STATUS:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-status",
        threadId: "slack:C_STATUS:1700000000.000",
        text: "show the channel",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(fakeAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(fakeAdapter.statusCalls[0]).toEqual(
      expect.objectContaining({
        channelId: "C_STATUS",
        threadTs: "1700000000.000",
      }),
    );
    expect(fakeAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C_STATUS",
      threadTs: "1700000000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("does not block assistant reply generation on slow assistant status writes", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let releaseFirstStatus: (() => void) | undefined;
    let statusCallCount = 0;
    fakeAdapter.setAssistantStatus = async () => {
      statusCallCount += 1;
      if (statusCallCount !== 1) {
        return;
      }
      await new Promise<void>((resolve) => {
        releaseFirstStatus = resolve;
      });
    };

    let replyStarted = false;
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () => ({ text: "Status thread" }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyStarted = true;
            return {
              text: "Still replied while status was pending.",
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

    let settled = false;
    const thread = createTestThread({
      id: "slack:D_STATUSBLOCK:1700000000.000",
    });
    const turnPromise = slackRuntime
      .handleNewMention(
        thread,
        createTestMessage({
          id: "msg-status-block",
          threadId: "slack:D_STATUSBLOCK:1700000000.000",
          text: "show the channel",
          isMention: true,
        }),
        { destination: createTestDestination(thread) },
      )
      .then(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(replyStarted).toBe(true);
    });

    expect(settled).toBe(false);

    releaseFirstStatus!();
    await turnPromise;
  });

  it("posts the final reply even while the initial assistant status write is pending", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let releaseFirstStatus: (() => void) | undefined;
    let statusCallCount = 0;
    fakeAdapter.setAssistantStatus = async (
      channelId,
      threadTs,
      text,
      loadingMessages,
    ) => {
      statusCallCount += 1;
      if (statusCallCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstStatus = resolve;
        });
      }
      fakeAdapter.statusCalls.push({
        channelId,
        threadTs,
        text,
        loadingMessages,
      });
    };

    let replyStarted = false;
    const thread = createTestThread({
      id: "slack:D_STATUSORDER:1700000001.000",
    });
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () => ({ text: "Status thread" }) as never,
        },
        replyExecutor: {
          generateAssistantReply: async () => {
            replyStarted = true;
            return {
              text: "Reply lands after the pending status is drained.",
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

    let settled = false;
    const turnPromise = slackRuntime
      .handleNewMention(
        thread,
        createTestMessage({
          id: "msg-status-order",
          threadId: thread.id,
          text: "answer quickly",
          isMention: true,
        }),
        { destination: createTestDestination(thread) },
      )
      .then(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(replyStarted).toBe(true);
      expect(thread.posts).toEqual([
        expect.objectContaining({
          markdown: "Reply lands after the pending status is drained.",
        }),
      ]);
    });

    expect(settled).toBe(false);

    releaseFirstStatus!();
    await turnPromise;
  });

  it("thread title: generates and sets title after first assistant reply", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Debugging Node.js Memory Leaks",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Here is how to debug memory leaks.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title-1",
        threadId: "slack:D_TITLE:1700000000.000",
        text: "How do I debug memory leaks in Node?",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    await new Promise((r) => setTimeout(r, 0));

    const generatedTitleCall = fakeAdapter.titleCalls.find(
      (c) => c.title !== "Junior",
    );
    expect(generatedTitleCall).toBeDefined();
    expect(generatedTitleCall!.title).toBe("Debugging Node.js Memory Leaks");
    expect(generatedTitleCall!.channelId).toBe("D_TITLE");
    expect(generatedTitleCall!.threadTs).toBe("1700000000.000");
  });

  it("thread title: uses the first human message we know about in the thread", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async (params) => {
            const prompt =
              typeof params.messages[0]?.content === "string"
                ? params.messages[0].content
                : "";
            return {
              text: prompt.includes("Original production issue summary")
                ? "Production Issue Summary"
                : "Follow-up Clarification",
              message: { role: "assistant", content: "" },
            } as any;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Here is the updated answer.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE4:1700000000.000" });
    const earlierMessage = createTestMessage({
      id: "msg-title4-earlier",
      threadId: "slack:D_TITLE4:1700000000.000",
      text: "Original production issue summary",
      author: { userId: "U-title4", isBot: false },
    });
    earlierMessage.metadata.dateSent = new Date(1_700_000_000_000);
    thread.recentMessages = [earlierMessage];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title4-current",
        threadId: "slack:D_TITLE4:1700000000.000",
        text: "Can you also include the regression window?",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    await new Promise((r) => setTimeout(r, 0));

    const generatedTitleCall = fakeAdapter.titleCalls.find(
      (c) => c.title !== "Junior",
    );
    expect(generatedTitleCall).toBeDefined();
    expect(generatedTitleCall!.title).toBe("Production Issue Summary");
  });

  it("thread title: still generates for a new thread with starter assistant content", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Today's Date",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Today is April 16, 2026.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({
      id: "slack:D_TITLE5:1700000000.000",
    });
    const starterMessage = createTestMessage({
      id: "msg-title5-starter",
      threadId: "slack:D_TITLE5:1700000000.000",
      text: "How can I help?",
      author: {
        isBot: true,
        isMe: true,
        userId: "B-title5",
        userName: "junior",
      },
    });
    starterMessage.metadata.dateSent = new Date(1_700_000_000_000);
    thread.recentMessages = [starterMessage];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title5-user",
        threadId: "slack:D_TITLE5:1700000000.000",
        text: "what's today's date",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    await new Promise((r) => setTimeout(r, 0));

    const generatedTitleCall = fakeAdapter.titleCalls.find(
      (c) => c.title !== "Junior",
    );
    expect(generatedTitleCall).toBeDefined();
    expect(generatedTitleCall!.title).toBe("Today's Date");
  });

  it("thread title: does not block reply delivery when generation is slow", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let resolveTitle: (() => void) | undefined;
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            await new Promise((resolve) => {
              resolveTitle = () =>
                resolve({
                  text: "Today's Date",
                  message: { role: "assistant", content: "" },
                } as any);
            }),
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Today is April 16, 2026.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE6:1700000000.000" });
    let settled = false;
    const turnPromise = slackRuntime
      .handleNewMention(
        thread,
        createTestMessage({
          id: "msg-title-6",
          threadId: "slack:D_TITLE6:1700000000.000",
          text: "what's today's date",
          isMention: true,
        }),
        { destination: createTestDestination(thread) },
      )
      .then(() => {
        settled = true;
      });

    await vi.waitFor(() => {
      expect(postIncludes(thread, "Today is April 16, 2026.")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(settled).toBe(true);
    });
    expect(
      fakeAdapter.titleCalls.some((call) => call.title === "Today's Date"),
    ).toBe(false);

    resolveTitle!();
    await turnPromise;
    await vi.waitFor(() => {
      expect(
        fakeAdapter.titleCalls.some((call) => call.title === "Today's Date"),
      ).toBe(true);
    });
  });

  it("thread title: preserves artifact updates when title resolves before completion", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Today's Date",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async (
            _text: string,
            context?: ReplyRequestContext,
          ) => {
            await vi.waitFor(() => {
              expect(
                fakeAdapter.titleCalls.some(
                  (call) => call.title === "Today's Date",
                ),
              ).toBe(true);
            });
            await context?.onArtifactStateUpdated?.({
              lastCanvasId: "F_CANVAS",
            });
            return {
              text: "Today is April 16, 2026.",
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

    const thread = createTestThread({ id: "slack:D_TITLE7:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title-7",
        threadId: "slack:D_TITLE7:1700000000.000",
        text: "what's today's date",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(thread.getState()).toMatchObject({
      artifacts: {
        assistantTitle: "Today's Date",
        lastCanvasId: "F_CANVAS",
      },
    });
  });

  it("thread title: does not generate title on subsequent replies", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let turnCount = 0;
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Some Title",
              message: { role: "assistant", content: "" },
            }) as any,
        },
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

    const thread = createTestThread({ id: "slack:D_TITLE2:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-1",
        threadId: "slack:D_TITLE2:1700000000.000",
        text: "first message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );
    await new Promise((r) => setTimeout(r, 0));

    const titleCallsAfterFirst = fakeAdapter.titleCalls.filter(
      (c) => c.title !== "Junior",
    ).length;
    expect(titleCallsAfterFirst).toBe(1);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-2",
        threadId: "slack:D_TITLE2:1700000000.000",
        text: "second message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );
    await new Promise((r) => setTimeout(r, 0));

    const titleCallsAfterSecond = fakeAdapter.titleCalls.filter(
      (c) => c.title !== "Junior",
    ).length;
    expect(titleCallsAfterSecond).toBe(1);
  });

  it("thread title: ignores Slack permission errors when setting title", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    fakeAdapter.setAssistantTitle = async () => {
      const error = new Error(
        "An API error occurred: no_permission",
      ) as Error & {
        data?: { error?: string };
      };
      error.data = { error: "no_permission" };
      throw error;
    };
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () =>
            ({
              text: "Permission Safe Title",
              message: { role: "assistant", content: "" },
            }) as any,
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "This reply should still succeed.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE3:1700000000.000" });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-title-3",
          threadId: "slack:D_TITLE3:1700000000.000",
          text: "title this thread please",
          isMention: true,
        }),
        { destination: createTestDestination(thread) },
      ),
    ).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    expect(thread.posts.length).toBeGreaterThan(0);
  });

  it("thread title: does not regenerate after stable Slack permission failures", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    fakeAdapter.setAssistantTitle = async () => {
      const error = new Error(
        "An API error occurred: no_permission",
      ) as Error & {
        data?: { error?: string };
      };
      error.data = { error: "no_permission" };
      throw error;
    };

    let titleGenerationCount = 0;
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () => {
            titleGenerationCount += 1;
            return {
              text: "Stable Permission Title",
              message: { role: "assistant", content: "" },
            } as any;
          },
        },
        replyExecutor: {
          generateAssistantReply: async () => ({
            text: "Reply still succeeds.",
            diagnostics: {
              assistantMessageCount: 1,
              modelId: "test-model",
              outcome: "success" as const,
              toolCalls: [],
              toolErrorCount: 0,
              toolResultCount: 0,
              usedPrimaryText: true,
            },
          }),
        },
      },
    });

    const thread = createTestThread({ id: "slack:D_TITLE7:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title7-1",
        threadId: "slack:D_TITLE7:1700000000.000",
        text: "first message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title7-2",
        threadId: "slack:D_TITLE7:1700000000.000",
        text: "second message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(titleGenerationCount).toBe(1);
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
      { destination: createTestDestination(thread) },
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

    await slackRuntime.handleNewMention(thread, currentMessage, {
      destination: createTestDestination(thread),
    });

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

    await slackRuntime.handleSubscribedMessage(thread, firstMessage, {
      destination: createTestDestination(thread),
    });

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
      { destination: createTestDestination(thread) },
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
      { destination: createTestDestination(thread) },
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
