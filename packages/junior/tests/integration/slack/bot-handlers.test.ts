import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
} from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource, type Destination } from "@sentry/junior-plugin-api";
import { executeAgentRun } from "@/chat/agent";
import type { JuniorRuntimeServiceOverrides } from "@/chat/app/services";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { acquireActiveLock } from "@/chat/state/locks";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import { instructionActors } from "@/chat/conversations/provenance";
import {
  loadProjection,
  loadConversationProjection,
  recordTurnRoute,
} from "@/chat/conversations/projection";
import { projectConversationReportEventPage } from "@/api/conversations/events";
import { getConversationEventStore } from "@/chat/db";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/messages";
import {
  coerceThreadConversationState,
  type ConversationMessage,
} from "@/chat/state/conversation";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import {
  wakePausedTurn as schedulePausedTurnWake,
  type PausedTurnRequest,
} from "@/chat/task-execution/turn-wake";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import {
  FakeSlackAdapter,
  createTestThread,
  createTestMessage,
  createTestDestination,
} from "../../fixtures/slack-harness";
import { createTestChatRuntime } from "../../fixtures/chat-runtime";
import { resetConversationTitleStateForTests } from "@/chat/services/conversation-title";
import { resetAssistantTitleProjectionForTests } from "@/chat/slack/assistant-thread/title";
import {
  createModelAgentRunner,
  createModelAgentRunnerForRun,
  neverRunAgentRunner,
} from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";
import {
  createConversationWorkQueueTestAdapter,
  deferred,
  type ConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import {
  mockTitleModel,
  type TitleModelRequest,
} from "../../fixtures/title-model";
import { mockTurnRouterModel } from "../../fixtures/turn-router-model";

const emptyThreadReplies = async () => [];
const ORIGINAL_AI_GATEWAY_API_KEY = process.env.AI_GATEWAY_API_KEY;

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

/**
 * Load a conversation's runtime scratch from thread-state and its visible
 * transcript from SQL, matching how the runtime hydrates the working set.
 */
async function loadVisibleConversation(thread: {
  id: string;
  getState: () => Promise<unknown>;
}) {
  const conversation = coerceThreadConversationState(await thread.getState());
  await hydrateConversationMessages({
    conversation,
    conversationId: thread.id,
  });
  return conversation;
}

/** Seed a prior visible transcript into SQL (the durable transcript authority). */
async function seedVisibleConversation(
  conversationId: string,
  messages: ConversationMessage[],
): Promise<void> {
  const conversation = coerceThreadConversationState({});
  conversation.messages.push(...messages);
  await persistConversationMessages({ conversation, conversationId });
}

async function loadTurnLifecycleEvents(conversationId: string) {
  return (await getConversationEventStore().loadHistory(conversationId)).filter(
    (event) =>
      event.data.type === "turn_started" ||
      event.data.type === "turn_completed" ||
      event.data.type === "turn_failed",
  );
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

    visibility: "private",
  });
}

function slackDestination(channelId: string) {
  return {
    platform: "slack",
    teamId: "T123",
    channelId,
  } satisfies Destination;
}

function bindPausedTurnQueue(queue: ConversationWorkQueueTestAdapter) {
  return async (request: PausedTurnRequest): Promise<void> => {
    await schedulePausedTurnWake(request, { queue });
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
    process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
    mockTurnRouterModel();
    mockTitleModel("Test conversation");
    resetConversationTitleStateForTests();
    resetAssistantTitleProjectionForTests();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    if (ORIGINAL_AI_GATEWAY_API_KEY === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = ORIGINAL_AI_GATEWAY_API_KEY;
    }
    resetSlackApiMockState();
    resetConversationTitleStateForTests();
    resetAssistantTitleProjectionForTests();
    vi.restoreAllMocks();
    await disconnectStateAdapter();
  });

  it("handleNewMention: posts reply from executeAgentRun", async () => {
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([{ type: "text", text: "Hello from the bot!" }]),
          ),
          scheduleSessionCompletedPluginTasks,
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = await createTestThread({ id: "slack:C0INT:1700000000.000" });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-new-mention",
        threadId: "slack:C0INT:1700000000.000",
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
      conversationId: "slack:C0INT:1700000000.000",
      sessionId: "turn_msg-new-mention",
    });
  });

  it("does not replay a message that already has a delivered reply", async () => {
    const conversationId = "slack:C0REPLAY:1700000000.000";
    const executeAgentRun = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run: executeAgentRun },
        },
      },
    });
    const thread = await createTestThread({
      id: conversationId,
      state: {
        conversation: {
          schemaVersion: 1,
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
          vision: {
            byFileId: {},
          },
        },
      },
    });

    await seedVisibleConversation(conversationId, [
      {
        id: "msg-replayed",
        role: "user",
        text: "please answer once",
        createdAtMs: 1,
        author: { userId: "U-test" },
        meta: { replied: true, slackTs: "1700000000.000" },
      },
      {
        id: "assistant-reply",
        role: "assistant",
        text: "Already answered.",
        createdAtMs: 2,
        author: { isBot: true, userName: "Junior" },
        meta: { replied: true },
      },
    ]);

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

    const thread = await createTestThread({
      id: "slack:C0SKIP:1700000000.000",
    });

    await slackRuntime.handleSubscribedMessage(
      thread,
      createTestMessage({
        id: "msg-sub-skip",
        threadId: "slack:C0SKIP:1700000000.000",
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
    const conversation = await loadVisibleConversation(thread);
    const lastMsg = conversation?.messages?.[conversation.messages.length - 1];
    expect(lastMsg?.meta?.replied).toBe(false);
  });

  it("handleAssistantThreadStarted: sets title and suggested prompts via adapter", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createTestChatRuntime({
      slackAdapter: fakeAdapter,
    });

    await slackRuntime.handleAssistantThreadStarted({
      threadId: "slack:C0ASSIST:1700000000.000",
      channelId: "C0ASSIST",
      threadTs: "1700000000.000",
      userId: "U-starter",
    });

    expect(fakeAdapter.titleCalls.length).toBe(1);
    expect(fakeAdapter.titleCalls[0].title).toBe("Junior");
    expect(fakeAdapter.titleCalls[0].channelId).toBe("C0ASSIST");
    expect(fakeAdapter.promptCalls.length).toBe(1);
    expect(fakeAdapter.promptCalls[0].prompts.length).toBe(3);
  });

  it("posts a sanitized error message when the model fails", async () => {
    const conversationId = "slack:C0ERR:1700000000.000";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              { type: "error", errorMessage: "LLM unavailable" },
            ]),
          ),
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });

    const thread = await createTestThread({ id: conversationId });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-err",
        threadId: conversationId,
        text: "trigger an error",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(
      postIncludes(
        thread,
        "I ran into an internal error while processing that.",
      ),
    ).toBe(true);
    expect(JSON.stringify(thread.posts)).not.toContain("LLM unavailable");
    const lifecycle = await loadTurnLifecycleEvents(conversationId);
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: "turn_msg-err",
      }),
      expect.objectContaining({
        type: "turn_failed",
        turnId: "turn_msg-err",
        eventId: expect.stringMatching(/^[a-f0-9]{32}$/i),
        failureCode: "model_execution_failed",
      }),
    ]);
  });

  it("does not persist an assistant message when final Slack delivery fails", async () => {
    const conversationId = "slack:C0DELIVERYFAIL:1700000000.000";
    const sessionId = "turn_msg-delivery-fail";
    const finalText = "This reply never reaches Slack.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([{ type: "text", text: finalText }]),
          ),
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });
    const thread = await createTestThread({
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

    const conversation = await loadVisibleConversation(thread);
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
    const sessionRecord = await getTurnRecord(conversationId, sessionId);
    expect(sessionRecord?.state).toBe("failed");
    const projection = await loadProjection({ conversationId });
    expect(JSON.stringify(projection)).not.toContain(finalText);
    const lifecycle = await loadTurnLifecycleEvents(conversationId);
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: sessionId,
      }),
      expect.objectContaining({
        type: "turn_failed",
        turnId: sessionId,
        eventId: expect.stringMatching(/^[a-f0-9]{32}$/i),
        failureCode: "delivery_failed",
      }),
    ]);
  });

  it("commits real agent history before the Slack reply when later state persistence fails", async () => {
    const conversationId = "slack:C0POSTDELIVERY:1700000000.000";
    const sessionId = "turn_msg-post-delivery";
    const finalText = "Delivered before the state store failed.";
    const { slackRuntime } = createTestChatRuntime({
      services: {
        replyExecutor: {
          agentRunner: {
            run: async (request) => {
              await recordTurnRoute({
                conversationId,
                turnId: request.turnId,
                modelProfile: "standard",
                modelId: "test/model",
                reasoningLevel: "medium",
                source: "configured",
              });
              const modelStream = createModelStream([
                {
                  type: "message",
                  message: fauxAssistantMessage([
                    fauxThinking("Check the final answer."),
                    fauxText(finalText),
                  ]),
                },
              ]);
              return executeAgentRun(request, modelStream);
            },
          },
        },
        visionContext: {
          listThreadReplies: async () => [],
        },
      },
    });
    const thread = await createTestThread({ id: conversationId });
    const originalPost = thread.post.bind(thread);
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const stateAdapter = getStateAdapter();
    const originalSet = stateAdapter.set.bind(stateAdapter);
    let replyPosted = false;
    let postDeliveryStateAttempted = false;
    thread.post = (async (message: unknown) => {
      const sent = await originalPost(
        message as Parameters<typeof originalPost>[0],
      );
      replyPosted = true;
      return sent;
    }) as typeof thread.post;
    stateAdapter.set = (async (key, value, ttlMs) => {
      if (
        replyPosted &&
        typeof key === "string" &&
        key.startsWith(`thread-state:${conversationId}`)
      ) {
        postDeliveryStateAttempted = true;
        throw new Error("state store unavailable");
      }
      return originalSet(key, value, ttlMs);
    }) as typeof stateAdapter.set;

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
    expect(postDeliveryStateAttempted).toBe(true);
    expect(
      postIncludes(
        thread,
        "I ran into an internal error while processing that.",
      ),
    ).toBe(false);

    const conversation = await loadVisibleConversation(thread);
    expect(conversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          text: finalText,
        }),
        expect.objectContaining({
          id: "msg-post-delivery",
          meta: expect.objectContaining({ replied: true }),
        }),
      ]),
    );
    await expect(
      getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({ state: "completed" });
    await expect(loadProjection({ conversationId })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant" })]),
    );
    const report = projectConversationReportEventPage({
      canExposePayload: true,
      events: await getConversationEventStore().loadHistory(conversationId),
    });
    expect(
      report
        .filter(
          (event) =>
            event.data.type === "assistant_message" ||
            (event.data.type === "message" && event.data.role === "assistant"),
        )
        .map((event) => event.data),
    ).toMatchObject([
      {
        type: "assistant_message",
        parts: [{ type: "reasoning", text: "Check the final answer." }],
      },
      {
        type: "message",
        role: "assistant",
        text: finalText,
      },
    ]);
    const lifecycle = await loadTurnLifecycleEvents(conversationId);
    expect(lifecycle.map((event) => event.data)).toEqual([
      expect.objectContaining({
        type: "turn_started",
        turnId: sessionId,
      }),
      expect.objectContaining({
        type: "turn_failed",
        turnId: sessionId,
        eventId: expect.stringMatching(/^[a-f0-9]{32}$/i),
        failureCode: "persistence_failed",
      }),
    ]);
  });

  it("passes conversation and turn identity into assistant reply context", async () => {
    const capturedIdentity: Array<{
      conversationId?: string;
      turnId?: string;
      runId?: string;
    }> = [];
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun((request) => {
            capturedIdentity.push({
              conversationId: request.conversationId,
              turnId: request.turnId,
              runId: request.runId,
            });
            return createModelStream([{ type: "text", text: "Done." }]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0CORRELATION:1700000000.000",
      runId: "run-123",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-correlation",
        threadId: "slack:C0CORRELATION:1700000000.000",
        text: "trace this turn",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(capturedIdentity).toHaveLength(1);
    expect(capturedIdentity[0]).toEqual(
      expect.objectContaining({
        conversationId: "slack:C0CORRELATION:1700000000.000",
        runId: "run-123",
      }),
    );
    expect(capturedIdentity[0].turnId).toBe("turn_msg-correlation");
  });

  it("answers a follow-up as a fresh turn when the active session is auth-parked", async () => {
    const conversationId = "slack:C0AUTHPARKED:1700000000.000";
    const activeSessionId = "turn_msg-auth-original";
    let agentRunCount = 0;
    let agentInstruction = "";
    await upsertTurnRecord({
      conversationId,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "auth",
      piMessages: turnPiMessages("please use notion"),
    });
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun((request) => {
            agentRunCount += 1;
            agentInstruction = request.instruction.text;
            return createModelStream([
              { type: "text", text: "Fresh answer without the provider." },
            ]);
          }),
        },
      },
    });

    const thread = await createTestThread({
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
    expect(agentRunCount).toBe(1);
    expect(agentInstruction).toContain("any update?");
    expect(postIncludes(thread, "Fresh answer without the provider.")).toBe(
      true,
    );
    await expect(
      getTurnRecord(conversationId, activeSessionId),
    ).resolves.toMatchObject({
      state: "abandoned",
      errorMessage: "Auth-parked session superseded by a new user message",
    });
    const state = await thread.getState();
    const conversation = (
      state as {
        conversation?: { processing?: { activeTurnId?: string } };
      }
    ).conversation;
    expect(conversation?.processing?.activeTurnId).toBeUndefined();
  });

  it("commits follow-up input before requesting a turn resume", async () => {
    const conversationId = "slack:C9PARKEDLOG:1700000000.000";
    const destination = slackDestination("C9PARKEDLOG");
    const activeSessionId = "turn_msg-original";
    const storedSource = createSlackSourceForTest("C9PARKEDLOG");
    await upsertTurnRecord({
      conversationId,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      destination,
      source: storedSource,
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const finishQueueSend = deferred();
    const queueSendEntered = queue.holdNextSendUntil(finishQueueSend.promise);
    const ack = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });

    const thread = await createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });
    const followUp = createTestMessage({
      id: "msg-parked-follow-up",
      threadId: conversationId,
      text: "also check the logs",
      isMention: true,
    });

    const handlePromise = slackRuntime.handleNewMention(thread, followUp, {
      destination,
      ack,
    });
    await queueSendEntered;

    // Input reaches the durable transcript before the queue handoff completes.
    expect(JSON.stringify(await loadProjection({ conversationId }))).toContain(
      "also check the logs",
    );
    expect(ack).not.toHaveBeenCalled();
    finishQueueSend.resolve();
    await handlePromise;

    expect(thread.posts).toEqual([]);
    expect(ack).toHaveBeenCalledOnce();
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${activeSessionId}:1:`,
        ),
      }),
    ]);

    // The resumed continue() replays the record's Pi history, which must now
    // end with the follow-up at a continuable user boundary.
    const record = await getTurnRecord(conversationId, activeSessionId);
    expect(record?.state).toBe("paused");
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
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("appends only the missing parked messages on a partial-overlap redelivery", async () => {
    const conversationId = "slack:C9PARKEDPART:1700000000.000";
    const destination = slackDestination("C9PARKEDPART");
    const activeSessionId = "turn_msg-original";
    await upsertTurnRecord({
      conversationId,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      destination,
      source: createSlackSourceForTest("C9PARKEDPART"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });
    const thread = await createTestThread({
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
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("records each parked follow-up author's own instruction provenance", async () => {
    const conversationId = "slack:C9PARKEDAUTH:1700000000.000";
    const destination = slackDestination("C9PARKEDAUTH");
    const activeSessionId = "turn_msg-original";
    await upsertTurnRecord({
      conversationId,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      destination,
      source: createSlackSourceForTest("C9PARKEDAUTH"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });
    const thread = await createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });
    const fromAlice = createTestMessage({
      id: "msg-parked-alice",
      threadId: conversationId,
      text: "alice question",
      isMention: true,
      author: { userId: "U-alice" },
    });
    const fromBob = createTestMessage({
      id: "msg-parked-bob",
      threadId: conversationId,
      text: "bob question",
      isMention: true,
      author: { userId: "U-bob" },
    });

    // A single drain carries two mentions from different authors: each must
    // keep its own author, not be collapsed to one latest-wins actor.
    await slackRuntime.handleNewMention(thread, fromBob, {
      destination,
      messageContext: { skipped: [fromAlice], totalSinceLastHandler: 1 },
    });

    const projection = await loadConversationProjection({ conversationId });
    const entries = projection.messages.map((message, index) => ({
      text: JSON.stringify(
        (message as { content?: unknown }).content ?? message,
      ),
      provenance: projection.provenance[index],
    }));
    const aliceEntry = entries.find((entry) =>
      entry.text.includes("alice question"),
    );
    const bobEntry = entries.find((entry) =>
      entry.text.includes("bob question"),
    );
    expect(aliceEntry?.provenance).toMatchObject({
      authority: "instruction",
      actor: { platform: "slack", teamId: "T123", userId: "U-alice" },
    });
    expect(bobEntry?.provenance).toMatchObject({
      authority: "instruction",
      actor: { platform: "slack", teamId: "T123", userId: "U-bob" },
    });
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("carries a batched mention's own author provenance into a fresh turn", async () => {
    const conversationId = "slack:C9BATCHFRESH:1700000000.000";
    const destination = slackDestination("C9BATCHFRESH");
    let capturedInput:
      | {
          piMessages?: unknown[];
        }
      | undefined;
    let capturedActorUserId: string | undefined;
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun((request) => {
            capturedInput = {
              piMessages: request.history ? [...request.history] : undefined,
            };
            const runActor = request.actor;
            capturedActorUserId =
              runActor && "userId" in runActor ? runActor.userId : undefined;
            return createModelStream([{ type: "text", text: "Recapped." }]);
          }),
        },
      },
    });
    const thread = await createTestThread({ id: conversationId });
    // Bob's mention was still pending when Alice's arrived, so the mailbox
    // drains both into Alice's fresh turn: Alice is the live run actor and
    // Bob's ask rides along as batched parked input.
    const fromBob = createTestMessage({
      id: "msg-batch-bob",
      threadId: conversationId,
      text: "bob question",
      isMention: true,
      author: { userId: "U-bob" },
    });
    const fromAlice = createTestMessage({
      id: "msg-batch-alice",
      threadId: conversationId,
      text: "alice recap request",
      isMention: true,
      author: { userId: "U-alice" },
    });

    await slackRuntime.handleNewMention(thread, fromAlice, {
      destination,
      messageContext: { skipped: [fromBob], totalSinceLastHandler: 1 },
    });

    expect(capturedActorUserId).toBe("U-alice");
    // The drain commits Bob's batched mention to the event log before the run
    // with his own instruction provenance, so he joins the run's actors instead
    // of being dropped as anonymous context under Alice's turn.
    const projection = await loadConversationProjection({ conversationId });
    const bobEntry = projection.messages
      .map((message, index) => ({
        text: JSON.stringify(
          (message as { content?: unknown }).content ?? message,
        ),
        provenance: projection.provenance[index],
      }))
      .find((entry) => entry.text.includes("bob question"));
    expect(bobEntry?.provenance).toMatchObject({
      authority: "instruction",
      actor: { platform: "slack", teamId: "T123", userId: "U-bob" },
    });
    expect(
      instructionActors(projection.provenance).map((actor) =>
        "userId" in actor ? actor.userId : undefined,
      ),
    ).toContain("U-bob");
    // The same committed message rides in the run's transcript, so the fresh
    // prompt checkpoint matches it as an already-committed prefix.
    expect(JSON.stringify(capturedInput?.piMessages ?? [])).toContain(
      "bob question",
    );
  });

  it("leaves the parked follow-up unconsumed while a live resume holds the thread lock", async () => {
    const conversationId = "slack:C9PARKEDLOCK:1700000000.000";
    const destination = slackDestination("C9PARKEDLOCK");
    const activeSessionId = "turn_msg-original";
    await upsertTurnRecord({
      conversationId,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      destination,
      source: createSlackSourceForTest("C9PARKEDLOCK"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const ack = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });
    const thread = await createTestThread({
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
    expect(queue.sentRecords()).toEqual([]);
    expect(
      JSON.stringify(await loadProjection({ conversationId })),
    ).not.toContain("also check the logs");
  });

  it("defers a batched fresh turn while a live resume holds the thread lock", async () => {
    const conversationId = "slack:C9BATCHLOCK:1700000000.000";
    const destination = slackDestination("C9BATCHLOCK");
    const run = vi.fn();
    const ack = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: { run },
        },
      },
    });
    const thread = await createTestThread({ id: conversationId });
    const fromBob = createTestMessage({
      id: "msg-batchlock-bob",
      threadId: conversationId,
      text: "bob pending ask",
      isMention: true,
      author: { userId: "U-bob" },
    });
    const fromAlice = createTestMessage({
      id: "msg-batchlock-alice",
      threadId: conversationId,
      text: "alice live ask",
      isMention: true,
      author: { userId: "U-alice" },
    });

    // Simulate a live resume: it holds the thread resume lock, so the batch
    // drain cannot commit provenance and the turn must defer, not run or fail.
    const stateAdapter = getStateAdapter();
    await stateAdapter.connect();
    const lock = await acquireActiveLock(stateAdapter, conversationId);
    expect(lock).not.toBeNull();
    try {
      await expect(
        slackRuntime.handleNewMention(thread, fromAlice, {
          destination,
          ack,
          messageContext: { skipped: [fromBob], totalSinceLastHandler: 1 },
        }),
      ).rejects.toThrow("Turn input is deferred until the active resume ends");
    } finally {
      await stateAdapter.releaseLock(lock!);
    }

    // Nothing ran, nothing was consumed, nothing was committed: the batch
    // stays pending in the mailbox for the next drain.
    expect(run).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await loadProjection({ conversationId })),
    ).not.toContain("bob pending ask");
  });

  it("fails malformed awaiting continuations before handling the follow-up", async () => {
    const conversationId = "slack:C0BADCONTINUATION:1700000000.000";
    const activeSessionId = "turn_msg-timeout-original";
    let agentRunCount = 0;
    await upsertTurnRecord({
      conversationId,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "timeout",
      piMessages: turnPiMessages("please keep working"),
    });
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun(() => {
            agentRunCount += 1;
            return createModelStream([{ type: "text", text: "Recovered." }]);
          }),
        },
      },
    });

    const thread = await createTestThread({
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

    expect(agentRunCount).toBe(1);
    expect(postIncludes(thread, "Recovered.")).toBe(true);
    const failedRecord = await getTurnRecord(conversationId, activeSessionId);
    expect(failedRecord?.state).toBe("failed");
    expect(failedRecord?.errorMessage).toBe(
      "Awaiting paused-turn metadata could not be materialized",
    );
    const state = await thread.getState();
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
    await upsertTurnRecord({
      conversationId,
      destination,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      source: createSlackSourceForTest("C9TIMEDUP"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });

    const thread = await createTestThread({
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

    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${activeSessionId}:1:`,
        ),
      }),
    ]);
  });

  it("does not reschedule an awaiting continuation for an already-replied duplicate", async () => {
    const conversationId = "slack:C9TIMEREPD:1700000000.000";
    const destination = slackDestination("C9TIMEREPD");
    const activeSessionId = "turn_msg-replied-duplicate";
    await upsertTurnRecord({
      conversationId,
      destination,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      source: createSlackSourceForTest("C9TIMEREPD"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const onTurnStatePersisted = vi.fn();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });

    const thread = await createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({
        activeSessionId,
        replied: true,
        userMessageId: "msg-replied-duplicate",
      }),
    });
    await seedVisibleConversation(conversationId, [
      {
        id: "msg-replied-duplicate",
        role: "user",
        text: "please keep working",
        createdAtMs: 1,
        author: { userId: "U-test" },
        meta: { replied: true },
      },
    ]);

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

    expect(queue.sentRecords()).toEqual([]);
    expect(onTurnStatePersisted).toHaveBeenCalledOnce();
    expect(thread.posts).toEqual([]);
  });

  it("does not start a new turn when rescheduling an active continuation fails", async () => {
    const conversationId = "slack:C9TIMEFAIL:1700000000.000";
    const destination = slackDestination("C9TIMEFAIL");
    const activeSessionId = "turn_msg-original";
    await upsertTurnRecord({
      conversationId,
      destination,
      turnId: activeSessionId,
      sliceId: 1,
      state: "paused",
      resumeReason: "yield",
      source: createSlackSourceForTest("C9TIMEFAIL"),
      piMessages: turnPiMessages("please keep working"),
      turnStartMessageIndex: 0,
    });
    const queue = createConversationWorkQueueTestAdapter();
    queue.rejectSends();
    const { slackRuntime } = createRuntime({
      services: {
        replyExecutor: {
          agentRunner: neverRunAgentRunner(),
          wakePausedTurn: bindPausedTurnQueue(queue),
        },
      },
    });

    const thread = await createTestThread({
      id: conversationId,
      state: createAwaitingContinuationState({ activeSessionId }),
    });

    const followUp = createTestMessage({
      id: "msg-retry-fail",
      threadId: conversationId,
      text: "what happened?",
      isMention: true,
    });
    await slackRuntime.handleNewMention(thread, followUp, { destination });

    expect(queue.queuedMessages()).toEqual([]);
    await expect(
      getTurnRecord(conversationId, buildDeterministicTurnId(followUp.id)),
    ).resolves.toBeUndefined();
    await expect(
      getTurnRecord(conversationId, activeSessionId),
    ).resolves.toMatchObject({ state: "paused" });
    expect(thread.posts).toEqual([
      expect.stringContaining(
        "I ran into an internal error while processing that.",
      ),
    ]);
  });

  it("emits assistant status updates in shared channel threads", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([{ type: "text", text: "Done." }]),
          ),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0STATUS:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-status",
        threadId: "slack:C0STATUS:1700000000.000",
        text: "show the channel",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(fakeAdapter.statusCalls.length).toBeGreaterThan(0);
    expect(fakeAdapter.statusCalls[0]).toEqual(
      expect.objectContaining({
        channelId: "C0STATUS",
        threadTs: "1700000000.000",
      }),
    );
    expect(fakeAdapter.statusCalls.at(-1)).toEqual({
      channelId: "C0STATUS",
      threadTs: "1700000000.000",
      text: "",
      loadingMessages: undefined,
    });
  });

  it("posts a completed message even while the initial assistant status write is pending", async () => {
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
    const thread = await createTestThread({
      id: "slack:D0STATUSORDER:1700000001.000",
    });
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        conversationMemory: {
          completeText: async () => ({ text: "Status thread" }) as never,
        },
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              {
                type: "text",
                text: "Reply lands after the pending status is drained.",
                onRequest: () => {
                  replyStarted = true;
                },
              },
            ]),
          ),
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

  it("thread title: uses the first human message we know about in the thread", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let titleRequest: TitleModelRequest | undefined;
    mockTitleModel("Production Issue Summary", {
      onRequest: (request) => {
        titleRequest = request;
      },
    });

    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              { type: "text", text: "Here is the updated answer." },
            ]),
          ),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:D0TITLE4:1700000000.000",
    });
    const earlierMessage = createTestMessage({
      id: "msg-title4-earlier",
      threadId: "slack:D0TITLE4:1700000000.000",
      text: "Original production issue summary",
      author: { userId: "U-title4", isBot: false },
    });
    earlierMessage.metadata.dateSent = new Date(1_700_000_000_000);
    thread.recentMessages = [earlierMessage];

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title4-current",
        threadId: "slack:D0TITLE4:1700000000.000",
        text: "Can you also include the regression window?",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    await vi.waitFor(() => {
      expect(
        fakeAdapter.titleCalls.some((call) => call.title !== "Junior"),
      ).toBe(true);
    });
    const generatedTitleCall = fakeAdapter.titleCalls.find(
      (call) => call.title !== "Junior",
    );
    expect(generatedTitleCall).toBeDefined();
    expect(generatedTitleCall!.title).toBe("Production Issue Summary");
    expect(JSON.stringify(titleRequest)).toContain(
      "Original production issue summary",
    );
    expect(JSON.stringify(titleRequest)).not.toContain(
      "Can you also include the regression window?",
    );
  });

  it("thread title: still generates for a new thread with starter assistant content", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    mockTitleModel("Today's Date");

    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              { type: "text", text: "Today is April 16, 2026." },
            ]),
          ),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:D0TITLE5:1700000000.000",
    });
    const starterMessage = createTestMessage({
      id: "msg-title5-starter",
      threadId: "slack:D0TITLE5:1700000000.000",
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
        threadId: "slack:D0TITLE5:1700000000.000",
        text: "what's today's date",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    await vi.waitFor(() => {
      expect(
        fakeAdapter.titleCalls.some((call) => call.title !== "Junior"),
      ).toBe(true);
    });
    const generatedTitleCall = fakeAdapter.titleCalls.find(
      (call) => call.title !== "Junior",
    );
    expect(generatedTitleCall).toBeDefined();
    expect(generatedTitleCall!.title).toBe("Today's Date");
  });

  it("thread title: preserves artifact updates when title resolves before completion", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    const titleReady = deferred();
    const recordTitle = fakeAdapter.setAssistantTitle.bind(fakeAdapter);
    fakeAdapter.setAssistantTitle = async (channelId, threadTs, title) => {
      await recordTitle(channelId, threadTs, title);
      if (title === "Today's Date") {
        titleReady.resolve();
      }
    };
    mockTitleModel("Today's Date");

    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              {
                type: "text",
                text: "Today is April 16, 2026.",
                waitFor: titleReady.promise,
              },
            ]),
          ),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:D0TITLE7:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title-7",
        threadId: "slack:D0TITLE7:1700000000.000",
        text: "what's today's date",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    expect(await thread.getState()).toMatchObject({});
  });

  it("thread title: does not generate title on subsequent replies", async () => {
    const fakeAdapter = new FakeSlackAdapter();
    let turnCount = 0;
    mockTitleModel("Some Title");
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunnerForRun(() => {
            turnCount += 1;
            return createModelStream([
              { type: "text", text: `reply-${turnCount}` },
            ]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:D0TITLE2:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-1",
        threadId: "slack:D0TITLE2:1700000000.000",
        text: "first message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );
    await vi.waitFor(() => {
      expect(
        fakeAdapter.titleCalls.filter((call) => call.title !== "Junior"),
      ).toHaveLength(1);
    });
    const titleCallsAfterFirst = fakeAdapter.titleCalls.filter(
      (call) => call.title !== "Junior",
    ).length;
    expect(titleCallsAfterFirst).toBe(1);

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2-2",
        threadId: "slack:D0TITLE2:1700000000.000",
        text: "second message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );
    await new Promise((r) => setTimeout(r, 0));

    const titleCallsAfterSecond = fakeAdapter.titleCalls.filter(
      (call) => call.title !== "Junior",
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
    mockTitleModel("Permission Safe Title");
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              { type: "text", text: "This reply should still succeed." },
            ]),
          ),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:D0TITLE3:1700000000.000",
    });

    await expect(
      slackRuntime.handleNewMention(
        thread,
        createTestMessage({
          id: "msg-title-3",
          threadId: "slack:D0TITLE3:1700000000.000",
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
    mockTitleModel("Stable Permission Title", {
      onRequest: () => {
        titleGenerationCount += 1;
      },
    });
    const { slackRuntime } = createRuntime({
      slackAdapter: fakeAdapter,
      services: {
        replyExecutor: {
          agentRunner: createModelAgentRunner(
            createModelStream([
              { type: "text", text: "Reply still succeeds." },
            ]),
          ),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:D0TITLE7:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title7-1",
        threadId: "slack:D0TITLE7:1700000000.000",
        text: "first message",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );
    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-title7-2",
        threadId: "slack:D0TITLE7:1700000000.000",
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            capturedContexts.push(run.instruction.context);
            return createModelStream([{ type: "text", text: "First reply." }]);
          }),
        },
      },
    });

    const threadId = "slack:C0FIRSTEMPTY:1700000000.000";
    const thread = await createTestThread({ id: threadId });

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
          agentRunner: createModelAgentRunnerForRun((run) => {
            capturedContexts.push(run.instruction.context);
            return createModelStream([
              { type: "text", text: "Follow-up reply." },
            ]);
          }),
        },
      },
    });

    const threadId = "slack:C0FIRSTEXISTING:1700000000.000";
    const thread = await createTestThread({ id: threadId });
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
    const syntheticMessage = createTestMessage({
      id: "msg-first-synthetic",
      threadId,
      text: "Automated deployment context.",
      author: {
        fullName: "unknown",
        isBot: true,
        userId: "unknown",
        userName: "unknown",
      },
    });
    syntheticMessage.metadata.dateSent = new Date(1_700_000_000_500);
    thread.recentMessages = [priorMessage, syntheticMessage, currentMessage];

    await slackRuntime.handleNewMention(thread, currentMessage, {
      destination: createTestDestination(thread),
    });

    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0]).toContain(
      '<thread-context authority="evidence-only">',
    );
    expect(capturedContexts[0]).toContain('author="Test User"');
    expect(capturedContexts[0]).toContain("[user] Test User:");
    expect(capturedContexts[0]).toContain("Original production issue summary.");
    expect(capturedContexts[0]).toContain("Automated deployment context.");
    expect(capturedContexts[0]).not.toContain(
      "Can you include the regression window?",
    );
    const report = projectConversationReportEventPage({
      canExposePayload: true,
      events: await getConversationEventStore().loadHistory(threadId),
    });
    expect(report).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            actorIdentity: expect.objectContaining({
              fullName: "Test User",
              slackUserName: "testuser",
            }),
            text: "Original production issue summary.",
            type: "message",
          }),
        }),
      ]),
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
          agentRunner: createModelAgentRunnerForRun((run) => {
            capturedContexts.push(run.instruction.context);
            return createModelStream([
              { type: "text", text: "Responding to first message only." },
            ]);
          }),
        },
      },
    });

    const threadId = "slack:D0ORDER:1700000000.000";
    const thread = await createTestThread({ id: threadId });
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
          agentRunner: createModelAgentRunnerForRun(() => {
            turnCount += 1;
            return createModelStream([
              { type: "text", text: `reply-${turnCount}` },
            ]);
          }),
        },
      },
    });

    const thread = await createTestThread({
      id: "slack:C0MULTI:1700000000.000",
    });

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t1",
        threadId: "slack:C0MULTI:1700000000.000",
        text: "first turn",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    const conv1 = await loadVisibleConversation(thread);
    expect(conv1).toBeDefined();
    const messageCountAfterFirst = conv1?.messages?.length ?? 0;

    await slackRuntime.handleNewMention(
      thread,
      createTestMessage({
        id: "msg-t2",
        threadId: "slack:C0MULTI:1700000000.000",
        text: "second turn",
        isMention: true,
      }),
      { destination: createTestDestination(thread) },
    );

    const conv2 = await loadVisibleConversation(thread);
    expect(conv2).toBeDefined();
    expect(conv2?.messages?.length ?? 0).toBeGreaterThan(
      messageCountAfterFirst,
    );
  });
});
