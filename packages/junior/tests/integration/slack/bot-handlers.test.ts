import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import { getSlackInterruptionMarker } from "@/chat/slack/output";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { loadProjection } from "@/chat/state/session-log";
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
import { flattenAgentRunRequestForTest } from "../../fixtures/agent-runner";

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

function expectBlocksIncludeConversationId(
  params: Record<string, unknown>,
  conversationId: string,
): void {
  expect(params.blocks).toBeDefined();
  expect(JSON.stringify(params.blocks)).toContain(conversationId);
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

function createSlackSourceForTest(channelId: string) {
  return createSlackSource({
    teamId: "T123",
    channelId,
    threadTs: "1700000000.000",

    type: "priv",
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

  it("handleNewMention: posts reply from executeAgentRun", async () => {
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          scheduleSessionCompletedPluginTasks,
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
    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledWith({
      conversationId: "slack:C_INT:1700000000.000",
      sessionId: "turn_msg-new-mention",
    });
  });

  it("does not replay a message that already has a delivered reply", async () => {
    const conversationId = "slack:C_REPLAY:1700000000.000";
    const executeAgentRun = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
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

    expect(executeAgentRun).not.toHaveBeenCalled();
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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

    // Should not have posted a reply (no executeAgentRun call)
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

  it("error recovery: posts safe error message when executeAgentRun throws", async () => {
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              throw new Error("LLM unavailable");
            },
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
    const conversationId = "slack:C_DELIVERY_FAIL:1700000000.000";
    const sessionId = "turn_msg-delivery-fail";
    const finalText = "This reply never reaches Slack.";
    const promptMessages = turnPiMessages("please answer");
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              // Simulate agent-run durable input checkpoint: the session record
              // is running at the prompt boundary when generation finishes.
              await upsertAgentTurnSessionRecord({
                conversationId,
                sessionId,
                sliceId: 1,
                state: "running",
                piMessages: promptMessages,
              });
              return completedAgentRun({
                text: finalText,
                piMessages: [
                  ...promptMessages,
                  {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: finalText }],
                    api: "responses" as const,
                    provider: "openai",
                    model: "gpt-5.3",
                    usage: {
                      input: 1,
                      output: 1,
                      cacheRead: 0,
                      cacheWrite: 0,
                      totalTokens: 2,
                      cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        total: 0,
                      },
                    },
                    stopReason: "stop" as const,
                    timestamp: 2,
                  },
                ],
                diagnostics: {
                  assistantMessageCount: 1,
                  modelId: "fake-agent-model",
                  outcome: "success" as const,
                  toolCalls: [],
                  toolErrorCount: 0,
                  toolResultCount: 0,
                  usedPrimaryText: true,
                },
              });
            },
          },
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });
    const thread = createTestThread({
      id: conversationId,
    });
    thread.post = vi.fn(async () => {
      throw new Error("Slack unavailable");
    }) as typeof thread.post;

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-delivery-fail",
          threadId: conversationId,
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

    // The session must not be recorded as delivered, and the undelivered
    // assistant reply must not surface to later turns as durable history.
    const sessionRecord = await getAgentTurnSessionRecord(
      conversationId,
      sessionId,
    );
    expect(sessionRecord?.state).toBe("failed");
    const projection = await loadProjection({ conversationId });
    expect(JSON.stringify(projection)).not.toContain(finalText);
  });

  it("keeps the turn successful when persistence fails after Slack accepted the reply", async () => {
    const conversationId = "slack:C_POST_DELIVERY:1700000000.000";
    const finalText = "Delivered before the state store failed.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () =>
              completedAgentRun({
                text: finalText,
                diagnostics: {
                  assistantMessageCount: 1,
                  modelId: "fake-agent-model",
                  outcome: "success" as const,
                  toolCalls: [],
                  toolErrorCount: 0,
                  toolResultCount: 0,
                  usedPrimaryText: true,
                },
              }),
          },
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });
    const thread = createTestThread({ id: conversationId });
    const originalPost = thread.post.bind(thread);
    const originalSetState = thread.setState.bind(thread);
    let replyPosted = false;
    thread.post = (async (message: unknown) => {
      const sent = await originalPost(
        message as Parameters<typeof originalPost>[0],
      );
      replyPosted = true;
      return sent;
    }) as typeof thread.post;
    thread.setState = (async (
      next: Parameters<typeof originalSetState>[0],
      options?: Parameters<typeof originalSetState>[1],
    ) => {
      if (replyPosted) {
        throw new Error("state store unavailable");
      }
      return originalSetState(next, options);
    }) as typeof thread.setState;

    // The user already saw the answer: post-delivery persistence failures are
    // logged, the turn stays successful, and no fallback failure reply posts.
    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-post-delivery",
          threadId: conversationId,
          text: "please answer",
          isMention: true,
        }),
        { destination: createTestDestination(thread) },
      ),
    ).resolves.toBeUndefined();

    expect(postIncludes(thread, finalText)).toBe(true);
    expect(
      postIncludes(
        thread,
        "I ran into an internal error while processing that.",
      ),
    ).toBe(false);
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
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              capturedCorrelation.push({
                conversationId: context?.correlation?.conversationId,
                threadId: context?.correlation?.threadId,
                turnId: context?.correlation?.turnId,
                runId: context?.correlation?.runId,
              });
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () => {
              return {
                status: "awaiting_auth",
                providerDisplayName: "Notion",
              };
            },
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

    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C_AUTH",
          thread_ts: "1700000000.000",
          text: "<@U-test> I'll need you to authorize Notion. I sent you a link.",
        }),
      }),
    ]);
    expectBlocksIncludeConversationId(
      getCapturedSlackApiCalls("chat.postMessage")[0]!.params,
      "slack:C_AUTH:1700000000.000",
    );
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
          agentRunner: {
            run: async () => {
              return {
                status: "awaiting_auth",
                providerDisplayName: "GitHub",
              };
            },
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

    expect(thread.posts).toEqual([]);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C_PLUGIN_AUTH",
          thread_ts: "1700000000.000",
          text: "<@U-test> I'll need you to authorize GitHub. I sent you a link.",
        }),
      }),
    ]);
    expectBlocksIncludeConversationId(
      getCapturedSlackApiCalls("chat.postMessage")[0]!.params,
      "slack:C_PLUGIN_AUTH:1700000000.000",
    );
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
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const conversationId = "slack:C9TIMEOUT:1700000000.000";
    const destination = slackDestination("C9TIMEOUT");
    const sessionId = "turn_msg-timeout";
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          scheduleAgentContinue,
          agentRunner: {
            run: async () => {
              return { status: "suspended", resumeVersion: 3 };
            },
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
          agentRunner: {
            run: async () => {
              return { status: "suspended", resumeVersion: 4 };
            },
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
          agentRunner: {
            run: async () => {
              return { status: "suspended", resumeVersion: 3 };
            },
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
    const executeAgentRun = vi.fn();
    const ack = vi.fn();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
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
          ack,
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
    expect(executeAgentRun).not.toHaveBeenCalled();
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(ack).toHaveBeenCalledOnce();
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

  it("answers a follow-up as a fresh turn when the active session is auth-parked", async () => {
    const conversationId = "slack:C_AUTH_PARKED:1700000000.000";
    const activeSessionId = "turn_msg-auth-original";
    const executeAgentRun = vi.fn().mockResolvedValue(
      completedAgentRun({
        text: "Fresh answer without the provider.",
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
    );
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
          agentRunner: { run: executeAgentRun },
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
      { destination: createTestDestination(thread) },
    );

    // The follow-up supersedes the pause: it must be answered, not consumed
    // into a resume that only happens if the user ever authorizes.
    expect(executeAgentRun).toHaveBeenCalledOnce();
    expect(executeAgentRun.mock.calls[0]?.[0].input.messageText).toContain(
      "any update?",
    );
    expect(postIncludes(thread, "Fresh answer without the provider.")).toBe(
      true,
    );
    await expect(
      getAgentTurnSessionRecord(conversationId, activeSessionId),
    ).resolves.toMatchObject({
      state: "abandoned",
      errorMessage: "Auth-parked session superseded by a new user message",
    });
    const state = thread.getState();
    const conversation = (
      state as {
        conversation?: { processing?: { activeTurnId?: string } };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
  });

  it("appends a parked-conversation follow-up to the session log before consuming it", async () => {
    const conversationId = "slack:C9PARKEDLOG:1700000000.000";
    const destination = slackDestination("C9PARKEDLOG");
    const activeSessionId = "turn_msg-original";
    const storedSource = createSlackSourceForTest("C9PARKEDLOG");
    const parkedRecord = await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "yield",
      destination,
      source: storedSource,
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const projectionAtScheduleTime: string[] = [];
    const scheduleAgentContinue = vi.fn(async () => {
      projectionAtScheduleTime.push(
        JSON.stringify(await loadProjection({ conversationId })),
      );
    });
    const executeAgentRun = vi.fn();
    const ack = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
          scheduleAgentContinue,
        },
      },
    });

    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });
    const followUp = createTestMessage({
      id: "msg-parked-follow-up",
      threadId: conversationId,
      text: "also check the logs",
      isMention: true,
    });

    await slackRuntime.handleNewMention(thread, followUp, {
      destination,
      ack,
    });

    expect(executeAgentRun).not.toHaveBeenCalled();
    expect(thread.posts).toEqual([]);
    expect(ack).toHaveBeenCalledOnce();
    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination,
      sessionId: activeSessionId,
      // The append is a log-only write: the resume request stays valid.
      expectedVersion: parkedRecord.version,
    });
    // The durable append happened before the continuation was scheduled.
    expect(projectionAtScheduleTime[0]).toContain("also check the logs");

    // The resumed continue() replays the record's Pi history, which must now
    // end with the follow-up at a continuable user boundary.
    const record = await getAgentTurnSessionRecord(
      conversationId,
      activeSessionId,
    );
    expect(record?.state).toBe("awaiting_resume");
    const lastMessage = record?.piMessages.at(-1) as
      | { content?: Array<{ text?: string }>; role?: string }
      | undefined;
    expect(lastMessage?.role).toBe("user");
    expect(JSON.stringify(lastMessage?.content)).toContain(
      "also check the logs",
    );

    // Redelivery of the same follow-up must not duplicate the append.
    await slackRuntime.handleNewMention(thread, followUp, {
      destination,
      ack,
    });
    const projection = await loadProjection({ conversationId });
    expect(
      JSON.stringify(projection).split("also check the logs"),
    ).toHaveLength(2);
  });

  it("appends only the missing parked messages on a partial-overlap redelivery", async () => {
    const conversationId = "slack:C9PARKEDPART:1700000000.000";
    const destination = slackDestination("C9PARKEDPART");
    const activeSessionId = "turn_msg-original";
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "yield",
      destination,
      source: createSlackSourceForTest("C9PARKEDPART"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const scheduleAgentContinue = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: vi.fn() },
          scheduleAgentContinue,
        },
      },
    });
    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });
    const first = createTestMessage({
      id: "msg-parked-first",
      threadId: conversationId,
      text: "first follow-up",
      isMention: true,
    });
    const second = createTestMessage({
      id: "msg-parked-second",
      threadId: conversationId,
      text: "second follow-up",
      isMention: true,
    });

    // First delivery durably appends the first follow-up.
    await slackRuntime.handleNewMention(thread, first, { destination });

    // Redelivery arrives carrying the already-appended message plus a new
    // one; only the missing message may be appended.
    await slackRuntime.handleNewMention(thread, second, {
      destination,
      messageContext: { skipped: [first], totalSinceLastHandler: 1 },
    });

    const serialized = JSON.stringify(await loadProjection({ conversationId }));
    expect(serialized.split("first follow-up")).toHaveLength(2);
    expect(serialized.split("second follow-up")).toHaveLength(2);
  });

  it("leaves the parked follow-up unconsumed while a live resume holds the thread lock", async () => {
    const conversationId = "slack:C9PARKEDLOCK:1700000000.000";
    const destination = slackDestination("C9PARKEDLOCK");
    const activeSessionId = "turn_msg-original";
    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: activeSessionId,
      sliceId: 1,
      state: "awaiting_resume",
      resumeReason: "yield",
      destination,
      source: createSlackSourceForTest("C9PARKEDLOCK"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const scheduleAgentContinue = vi.fn();
    const ack = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: vi.fn() },
          scheduleAgentContinue,
        },
      },
    });
    const thread = createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });
    const followUp = createTestMessage({
      id: "msg-parked-locked",
      threadId: conversationId,
      text: "also check the logs",
      isMention: true,
    });

    // Simulate a live resume: it holds the thread resume lock for its run.
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const lock = await acquireActiveLock(stateAdapter, conversationId);
    expect(lock).not.toBeNull();
    try {
      await expect(
        slackRuntime.handleNewMention(thread, followUp, {
          destination,
          ack,
        }),
      ).rejects.toThrow("Turn input is deferred until the active resume ends");
    } finally {
      await stateAdapter.releaseLock(lock!);
    }

    // The message was not consumed and nothing was appended or scheduled: it
    // stays pending in the mailbox for the next drain.
    expect(ack).not.toHaveBeenCalled();
    expect(scheduleAgentContinue).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await loadProjection({ conversationId })),
    ).not.toContain("also check the logs");
  });

  it("suppresses the visible failure reply when the mailbox will retry the delivery", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              throw new Error("transient turn failure");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_RETRYQUIET:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-retryable-failure",
        threadId: "slack:C_RETRYQUIET:1700000000.000",
        text: "do work",
        isMention: true,
      }),
      {
        destination: createTestDestination(thread),
        isFinalAttempt: false,
      },
    );

    expect(thread.posts).toEqual([]);
  });

  it("posts the failure fallback after ack even when the attempt is not final", async () => {
    const ack = vi.fn().mockResolvedValue(undefined);
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _input = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context.onInputCommitted?.();
              throw new Error("post-ack turn failure");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_RETRYACKED:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-acked-failure",
        threadId: "slack:C_RETRYACKED:1700000000.000",
        text: "do work",
        isMention: true,
      }),
      {
        ack,
        destination: createTestDestination(thread),
        isFinalAttempt: false,
      },
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });

  it("posts the failure fallback on the final delivery attempt", async () => {
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async () => {
              throw new Error("persistent turn failure");
            },
          },
        },
      },
    });

    const thread = createTestThread({
      id: "slack:C_RETRYFINAL:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-final-failure",
        threadId: "slack:C_RETRYFINAL:1700000000.000",
        text: "do work",
        isMention: true,
      }),
      {
        destination: createTestDestination(thread),
        isFinalAttempt: true,
      },
    );

    expect(thread.posts).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });

  it("fails malformed awaiting continuations before handling the follow-up", async () => {
    const conversationId = "slack:C_BAD_CONTINUATION:1700000000.000";
    const activeSessionId = "turn_msg-timeout-original";
    const executeAgentRun = vi.fn().mockResolvedValue(
      completedAgentRun({
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
      }),
    );
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
          agentRunner: { run: executeAgentRun },
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

    expect(executeAgentRun).toHaveBeenCalledOnce();
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
    const executeAgentRun = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
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
    expect(executeAgentRun).not.toHaveBeenCalled();
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
    const executeAgentRun = vi.fn();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
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
    expect(executeAgentRun).not.toHaveBeenCalled();
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
    const executeAgentRun = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
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
    expect(executeAgentRun).not.toHaveBeenCalled();
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
    const executeAgentRun = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
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

    expect(executeAgentRun).not.toHaveBeenCalled();
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
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onTextDelta?.("Partial output...");
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              await context?.onStatus?.(
                makeAssistantStatus("reading", "channel messages"),
              );
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () => {
              replyStarted = true;
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () => {
              replyStarted = true;
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          agentRunner: {
            run: async (request) => {
              const _text = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

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
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () => {
              turnCount += 1;
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          agentRunner: {
            run: async () =>
              completedAgentRun({
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
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              capturedContexts.push(context?.conversationContext);
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              capturedContexts.push(context?.conversationContext);
              return completedAgentRun({
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
              });
            },
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
                should_unsubscribe: false,
                confidence: 1,
                reason: "follow-up",
              },
              text: '{"should_reply":true,"should_unsubscribe":false,"confidence":1,"reason":"follow-up"}',
            }) as any,
        },
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              const _prompt = request.input.messageText;
              const context = {
                ...flattenAgentRunRequestForTest(request),
              };

              capturedContexts.push(context?.conversationContext);
              return completedAgentRun({
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
              });
            },
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
          agentRunner: {
            run: async () => {
              turnCount += 1;
              return completedAgentRun({
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
              });
            },
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
