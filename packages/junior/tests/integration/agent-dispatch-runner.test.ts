import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  createOrGetDispatch,
  getDispatchConversationId,
  getDispatchDestinationLockId,
  getDispatchRecord,
  getDispatchStorageKey,
  parseDispatchRecord,
  updateDispatchRecord,
  withDispatchLock,
} from "@/chat/agent-dispatch/store";
import {
  processAgentDispatchCallback as processAgentDispatchCallbackImpl,
  type AgentDispatchRunnerDeps,
} from "@/chat/agent-dispatch/runner";
import {
  getConversationEventStore,
  getConversationStore,
  getSqlExecutor,
} from "@/chat/db";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import {
  hydrateConversationMessages,
  persistConversationMessages,
} from "@/chat/conversations/visible-messages";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
  bindScheduledTaskCredentialSubject,
  bindSlackDirectCredentialSubject,
  createSlackDirectCredentialSubject,
} from "@/chat/credentials/subject";
import { getAgentTurnSessionRecord } from "@/chat/state/turn-session";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";
import { createAgentRunner } from "@/chat/runtime/agent-runner";
import { chatPostMessageOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
  queueSlackRateLimit,
} from "../msw/handlers/slack-api";
import { flattenAgentRunRequestForTest } from "../fixtures/agent-runner";
import { ConversationTurnLifecycleService } from "@/chat/conversations/turn-lifecycle";
import { RecoverableSlackDeliveryService } from "@/chat/slack/recoverable-delivery";
import {
  postRecoverableSlackMessage,
  reconcileRecoverableSlackMessage,
} from "@/chat/slack/outbound";
import { recoverStaleDispatches } from "@/chat/agent-dispatch/heartbeat";
import { deferred } from "../fixtures/conversation-work";

async function processAgentDispatchCallback(
  callback: Parameters<typeof processAgentDispatchCallbackImpl>[0],
  deps: Omit<
    AgentDispatchRunnerDeps,
    "recoverableSlackDelivery" | "turnLifecycle"
  >,
): Promise<void> {
  await processAgentDispatchCallbackImpl(callback, {
    ...deps,
    recoverableSlackDelivery: new RecoverableSlackDeliveryService(
      getSqlExecutor(),
      {
        post: postRecoverableSlackMessage,
        reconcile: reconcileRecoverableSlackMessage,
      },
    ),
    turnLifecycle: new ConversationTurnLifecycleService(
      getConversationEventStore(),
    ),
  });
}

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function createReply(): AgentRunResult {
  return {
    text: "Dispatch delivered.",
    deliveryMode: "thread",
    deliveryPlan: {
      mode: "thread",
      postThreadText: true,
    },
    diagnostics: {
      assistantMessageCount: 1,
      durationMs: 1234,
      modelId: "test-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
    },
    piMessages: [
      {
        role: "user",
        content: [{ type: "text", text: "Run the scheduled task." }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Dispatch delivered." }],
        api: "responses",
        provider: "openai",
        model: "test-model",
        stopReason: "stop",
        timestamp: 2,
        usage: zeroUsage(),
      },
    ],
  };
}

function failedDispatchPiMessages(): PiMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: "Run the scheduled task." }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [],
      api: "responses",
      provider: "openai",
      model: "test-model",
      errorMessage: "provider failed",
      stopReason: "error",
      timestamp: 2,
      usage: zeroUsage(),
    },
  ];
}

function createCredentialSubject() {
  const subject = createSlackDirectCredentialSubject({
    channelId: "D123",
    teamId: "T123",
    userId: "U123",
  });
  if (!subject) {
    throw new Error("Expected test credential subject to be created");
  }
  const boundSubject = bindSlackDirectCredentialSubject({
    channelId: "D123",
    teamId: "T123",
    subject,
  });
  if (!boundSubject) {
    throw new Error("Expected test credential subject to be bound");
  }
  return boundSubject;
}

function createScheduledTaskCredentialSubject() {
  const subject = bindScheduledTaskCredentialSubject({
    plugin: "scheduler",
    subject: {
      type: "user",
      userId: "U123",
      allowedWhen: "scheduled-task",
      taskId: "sched_runner_1",
    },
  });
  if (!subject) {
    throw new Error("Expected scheduled task credential subject to be bound");
  }
  return subject;
}

function slackAddress(channelId = "C123") {
  return {
    platform: "slack" as const,
    teamId: "T123",
    channelId,
  };
}

function slackSource(channelId = "C123") {
  return createSlackSource({
    ...slackAddress(channelId),

    type: "priv",
  });
}

describe("agent dispatch runner", () => {
  beforeEach(async () => {
    process.env.JUNIOR_SECRET = "dispatch-runner-secret";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_SECRET;
  });

  it("runs a system dispatch and persists Slack delivery", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000001",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-1",
        destination: slackAddress(),
        destinationVisibility: "public",
        input: "Run the scheduled task.",
        metadata: { runId: "run-1" },
        source: slackSource(),
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      expect(context.actor).toBeUndefined();
      expect(context.authorizationFlowMode).toBe("disabled");
      expect(context.surface).toBe("api");
      expect(context.source).toEqual(slackSource());
      expect(context.destinationVisibility).toBe("public");
      expect(context.slackConversation).toBeUndefined();
      expect(context.dispatch).toEqual({
        actor: { platform: "system", name: "scheduler" },
        metadata: { runId: "run-1" },
        plugin: "scheduler",
      });
      expect(context.correlation).toMatchObject({
        conversationId: dispatchConversationId,
        threadId: dispatchConversationId,
        channelId: "C123",
        teamId: "T123",
      });
      expect(context.credentialContext).toEqual({
        actor: { platform: "system", name: "scheduler" },
      });
      expect(context.sandboxTracePropagation).toEqual({
        domains: ["*.sentry.io"],
      });
      return completedAgentRun(createReply());
    });
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      {
        agentRunner: createAgentRunner(executeAgentRun, {
          tracePropagation: { domains: ["*.sentry.io"] },
        }),
        scheduleSessionCompletedPluginTasks,
      },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000001",
    });
    expect(getCapturedSlackApiCalls("chat.postMessage")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          text: "Dispatch delivered.",
        }),
      }),
    ]);
    const deliveredConversation = coerceThreadConversationState(
      await getPersistedThreadState(dispatchConversationId),
    );
    await hydrateConversationMessages({
      conversation: deliveredConversation,
      conversationId: dispatchConversationId,
    });
    expect(deliveredConversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `dispatch:${created.record.id}:user`,
          author: expect.objectContaining({
            userName: "system:scheduler",
            isBot: true,
          }),
        }),
        expect.objectContaining({
          id: `assistant:dispatch:${created.record.id}`,
          meta: expect.objectContaining({
            slackTs: "1700000000.000001",
          }),
        }),
      ]),
    );
    expect(scheduleSessionCompletedPluginTasks).toHaveBeenCalledWith({
      conversationId: dispatchConversationId,
      sessionId: `dispatch:${created.record.id}`,
    });
    await expect(
      getAgentTurnSessionRecord(
        dispatchConversationId,
        `dispatch:${created.record.id}`,
      ),
    ).resolves.toMatchObject({
      conversationId: dispatchConversationId,
      sessionId: `dispatch:${created.record.id}`,
      sliceId: 1,
      state: "completed",
      surface: "api",
    });
    await expect(
      getConversationStore().get({ conversationId: dispatchConversationId }),
    ).resolves.toMatchObject({
      destination: slackAddress(),
      visibility: "public",
    });
    await expect(getPersistedThreadState("slack:T123:C123")).resolves.toEqual(
      {},
    );
    const lifecycle = (
      await getConversationEventStore().loadHistory(dispatchConversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.map((event) => event.data)).toEqual([
      {
        type: "turn_started",
        turnId: `dispatch:${created.record.id}`,
        inputMessageIds: [`dispatch:${created.record.id}:user`],
        surface: "api",
      },
      {
        type: "turn_completed",
        turnId: `dispatch:${created.record.id}`,
        outcome: "success",
      },
    ]);
  });

  it.each([120, 500])(
    "uses the configured %ds host window for the agent deadline and lease",
    async (functionMaxDurationSeconds) => {
      const created = await createOrGetDispatch({
        plugin: "scheduler",
        nowMs: Date.now(),
        options: {
          idempotencyKey: `configured-function-lease-${functionMaxDurationSeconds}`,
          destination: slackAddress(),
          destinationVisibility: "private",
          input: "Run the scheduled task.",
          source: slackSource(),
        },
      });
      const entered = deferred<void>();
      const finish = deferred<void>();
      let turnDeadlineAtMs: number | undefined;
      let turnTimeoutMs: number | undefined;
      const running = processAgentDispatchCallback(
        {
          id: created.record.id,
          expectedVersion: created.record.version,
        },
        {
          agentRunner: {
            run: async (request) => {
              turnDeadlineAtMs = request.policy?.turnDeadlineAtMs;
              turnTimeoutMs = request.policy?.turnTimeoutMs;
              entered.resolve();
              await finish.promise;
              return completedAgentRun(createReply());
            },
          },
          functionMaxDurationSeconds,
        },
      );
      await entered.promise;

      const active = await getDispatchRecord(created.record.id);
      expect(active).toMatchObject({
        lastCallbackAtMs: expect.any(Number),
        leaseExpiresAtMs: expect.any(Number),
        status: "running",
      });
      const startedAtMs = active!.lastCallbackAtMs!;
      expect(turnTimeoutMs).toBe((functionMaxDurationSeconds - 20) * 1000);
      expect(turnDeadlineAtMs).toBe(
        startedAtMs + (functionMaxDurationSeconds - 20) * 1000,
      );
      expect(active!.leaseExpiresAtMs).toBe(
        startedAtMs + (functionMaxDurationSeconds + 20) * 1000,
      );

      const originalFetch = global.fetch;
      const fetchMock = vi.fn(
        async (..._args: Parameters<typeof fetch>) =>
          new Response("Accepted", { status: 202 }),
      );
      global.fetch = fetchMock as typeof fetch;
      try {
        await expect(
          recoverStaleDispatches({ nowMs: active!.leaseExpiresAtMs! - 1 }),
        ).resolves.toBe(0);
        await expect(
          recoverStaleDispatches({ nowMs: active!.leaseExpiresAtMs! }),
        ).resolves.toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        global.fetch = originalFetch;
        finish.resolve();
        await running;
      }
    },
  );

  it("retries pending delivery without consuming another model attempt", async () => {
    queueSlackRateLimit("chat.postMessage", 0);
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000009",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-delivery-retry",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const executeAgentRun = vi.fn(async () => completedAgentRun(createReply()));
    const scheduledCallbacks: Array<{
      expectedVersion: number;
      id: string;
      kind?: "delivery";
    }> = [];
    const scheduleCallback = vi.fn(async (callback) => {
      scheduledCallbacks.push(callback);
    });

    await processAgentDispatchCallback(
      { id: created.record.id, expectedVersion: created.record.version },
      { agentRunner: { run: executeAgentRun }, scheduleCallback },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      attempt: 1,
      status: "awaiting_resume",
      nextCallbackKind: "delivery",
    });
    expect(scheduledCallbacks).toEqual([
      {
        id: created.record.id,
        expectedVersion: expect.any(Number),
        kind: "delivery",
      },
    ]);

    await processAgentDispatchCallback(scheduledCallbacks[0]!, {
      agentRunner: { run: executeAgentRun },
      scheduleCallback,
    });

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      attempt: 1,
      status: "completed",
      resultMessageTs: "1700000000.000009",
    });
    expect(executeAgentRun).toHaveBeenCalledTimes(1);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(2);
  });

  it("starts dispatches without inherited destination conversation memory", async () => {
    const destinationConversation = coerceThreadConversationState({});
    destinationConversation.messages.push({
      id: "channel-message-1",
      role: "user",
      text: "Previous scheduled run failed with stale context.",
      createdAtMs: Date.parse("2026-05-25T12:00:00.000Z"),
      author: { userName: "alice" },
    });
    await persistConversationMessages({
      conversation: destinationConversation,
      conversationId: "slack:T123:C123",
    });
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000003",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-isolated-context",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        metadata: { runId: "run-isolated-context" },
        source: slackSource(),
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      expect(context.conversationContext).toBeUndefined();
      expect(context.piMessages).toEqual([]);
      return completedAgentRun(createReply());
    });

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun } },
    );

    const persistedDestination = coerceThreadConversationState(
      await getPersistedThreadState("slack:T123:C123"),
    );
    await hydrateConversationMessages({
      conversation: persistedDestination,
      conversationId: "slack:T123:C123",
    });
    expect(persistedDestination.messages.map((message) => message.id)).toEqual([
      "channel-message-1",
    ]);
    const dispatchConversation = coerceThreadConversationState(
      await getPersistedThreadState(dispatchConversationId),
    );
    await hydrateConversationMessages({
      conversation: dispatchConversation,
      conversationId: dispatchConversationId,
    });
    expect(dispatchConversation.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `dispatch:${created.record.id}:user`,
        }),
        expect.objectContaining({
          id: `assistant:dispatch:${created.record.id}`,
        }),
      ]),
    );
  });

  it("does not persist visible filler text for side-effect-only dispatches", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-side-effect-only",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "React to the scheduled thread.",
        source: slackSource(),
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const sideEffectReply = createReply();

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      {
        agentRunner: {
          run: async () =>
            completedAgentRun({
              ...sideEffectReply,
              text: "",
              deliveryPlan: {
                mode: "thread",
                postThreadText: false,
              },
              diagnostics: {
                ...sideEffectReply.diagnostics,
                toolCalls: ["addReaction"],
                usedPrimaryText: true,
              },
            }),
        },
      },
    );

    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
    });
    const sideEffectConversation = coerceThreadConversationState(
      await getPersistedThreadState(dispatchConversationId),
    );
    await hydrateConversationMessages({
      conversation: sideEffectConversation,
      conversationId: dispatchConversationId,
    });
    expect(sideEffectConversation.messages).toContainEqual(
      expect.objectContaining({ id: `dispatch:${created.record.id}:user` }),
    );
    expect(
      sideEffectConversation.messages.find(
        (message) => message.role === "assistant",
      ),
    ).toBeUndefined();
  });

  it("preserves task-scoped creator credentials across dispatch slices", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-timeout",
        credentialSubject: createScheduledTaskCredentialSubject(),
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const scheduleCallback = vi.fn(async () => undefined);
    const executeAgentRun = vi
      .fn<AgentRunner["run"]>()
      .mockResolvedValueOnce({ status: "suspended", resumeVersion: 7 })
      .mockImplementationOnce(async (request) => {
        expect(
          flattenAgentRunRequestForTest(request).credentialContext,
        ).toEqual({
          actor: { platform: "system", name: "scheduler" },
          subject: {
            type: "user",
            userId: "U123",
            allowedWhen: "scheduled-task",
            taskId: "sched_runner_1",
            binding: {
              type: "scheduled-task",
              plugin: "scheduler",
              taskId: "sched_runner_1",
              signature: expect.any(String),
            },
          },
        });
        return completedAgentRun(createReply());
      });

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun }, scheduleCallback },
    );

    const awaitingResume = await getDispatchRecord(created.record.id);
    expect(awaitingResume).toMatchObject({
      status: "awaiting_resume",
    });
    expect(scheduleCallback).toHaveBeenCalledWith({
      id: created.record.id,
      expectedVersion: expect.any(Number),
    });
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000001",
      }),
    });
    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: awaitingResume!.version,
      },
      { agentRunner: { run: executeAgentRun } },
    );
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("passes delegated credential subjects without changing the actor", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "D123",
        ts: "1700000000.000002",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-delegated",
        credentialSubject: createCredentialSubject(),
        destination: slackAddress("D123"),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource("D123"),
      },
    });
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      expect(context.actor).toBeUndefined();
      expect(context.credentialContext).toEqual({
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
          binding: {
            type: "slack-direct-conversation",
            teamId: "T123",
            channelId: "D123",
            signature: expect.any(String),
          },
        },
      });
      expect(context.authorizationFlowMode).toBe("disabled");
      return completedAgentRun(createReply());
    });

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun } },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000002",
    });
  });

  it("passes task-scoped creator credentials in channels without enabling OAuth", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000003",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-scheduled-task-delegated",
        credentialSubject: createScheduledTaskCredentialSubject(),
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const executeAgentRun = vi.fn<AgentRunner["run"]>(async (request) => {
      const context = flattenAgentRunRequestForTest(request);
      expect(context.credentialContext).toEqual({
        actor: { platform: "system", name: "scheduler" },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "scheduled-task",
          taskId: "sched_runner_1",
          binding: {
            type: "scheduled-task",
            plugin: "scheduler",
            taskId: "sched_runner_1",
            signature: expect.any(String),
          },
        },
      });
      expect(context.authorizationFlowMode).toBe("disabled");
      return completedAgentRun(createReply());
    });

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun } },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000003",
    });
  });

  it("does not re-post when the delivered-state persist fails after Slack accepted the reply", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000004",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-persist-fail",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const state = getStateAdapter();
    await state.connect();
    const originalSet = state.set.bind(state);
    const setSpy = vi
      .spyOn(state, "set")
      .mockImplementation(async (key, value, ttlMs) => {
        if (String(key).startsWith("thread-state:")) {
          throw new Error("state store unavailable");
        }
        return originalSet(key, value, ttlMs);
      });
    const scheduleSessionCompletedPluginTasks = vi.fn(async () => undefined);

    try {
      await processAgentDispatchCallback(
        {
          id: created.record.id,
          expectedVersion: created.record.version,
        },
        {
          agentRunner: { run: async () => completedAgentRun(createReply()) },
          scheduleSessionCompletedPluginTasks,
        },
      );
    } finally {
      setSpy.mockRestore();
    }

    // Slack accepted the write, but the durable intent remains until all
    // derived state is repaired. A delivery callback retries no model work.
    const awaitingRepair = await getDispatchRecord(created.record.id);
    expect(awaitingRepair).toMatchObject({
      attempt: 1,
      status: "awaiting_resume",
      nextCallbackKind: "delivery",
    });
    expect(
      (
        await getConversationEventStore().loadHistory(dispatchConversationId)
      ).filter((event) => event.data.type.startsWith("turn_")),
    ).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ type: "turn_started" }),
      }),
    ]);

    const rerunGenerate = vi.fn(async () => {
      throw new Error("must not regenerate a delivered dispatch");
    });
    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: awaitingRepair!.version,
        kind: "delivery",
      },
      { agentRunner: { run: rerunGenerate } },
    );
    expect(rerunGenerate).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      attempt: 1,
      status: "completed",
      resultMessageTs: "1700000000.000004",
    });
    const lifecycle = (
      await getConversationEventStore().loadHistory(dispatchConversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_completed",
      turnId: `dispatch:${created.record.id}`,
      outcome: "success",
    });
  });

  it("recovers an aged side-effect completion before a normal retry", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.now() - 25 * 60 * 60 * 1000,
      options: {
        idempotencyKey: "run-terminal-projection-write-fail",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const state = getStateAdapter();
    await state.connect();
    const ready = await getDispatchRecord(created.record.id);
    if (!ready) throw new Error("Expected dispatch record to exist");
    const originalSet = state.set.bind(state);
    let injectedFailures = 0;
    const setSpy = vi
      .spyOn(state, "set")
      .mockImplementation(async (key, value, ttlMs) => {
        const dispatch = parseDispatchRecord(value);
        if (
          String(key) === getDispatchStorageKey(created.record.id) &&
          dispatch?.status === "completed"
        ) {
          injectedFailures += 1;
          throw new Error("dispatch state store unavailable");
        }
        return originalSet(key, value, ttlMs);
      });
    const sideEffectReply = createReply();
    sideEffectReply.deliveryPlan = {
      mode: "channel_only",
      postThreadText: false,
    };

    try {
      await processAgentDispatchCallback(
        {
          id: created.record.id,
          expectedVersion: ready.version,
        },
        {
          agentRunner: {
            run: async () => completedAgentRun(sideEffectReply),
          },
        },
      );
    } finally {
      setSpy.mockRestore();
    }

    expect(injectedFailures).toBe(1);
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      attempt: 1,
      maxAttempts: 5,
      status: "running",
    });

    const originalFetch = global.fetch;
    const fetchMock = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response("Accepted", { status: 202 }),
    );
    global.fetch = fetchMock as typeof fetch;
    const delivery = new RecoverableSlackDeliveryService(getSqlExecutor(), {
      post: postRecoverableSlackMessage,
      reconcile: reconcileRecoverableSlackMessage,
    });
    try {
      await expect(
        recoverStaleDispatches({
          nowMs: Date.now() + 10 * 60 * 1000,
          recoverableSlackDelivery: delivery,
        }),
      ).resolves.toBe(1);
    } finally {
      global.fetch = originalFetch;
    }
    const callbackRequest = fetchMock.mock.calls.at(-1);
    const callback = JSON.parse(String(callbackRequest?.[1]?.body)) as {
      id: string;
      expectedVersion: number;
      kind: "delivery";
    };
    expect(callback).toMatchObject({ id: created.record.id, kind: "delivery" });
    const rerun = vi.fn(async () => completedAgentRun(sideEffectReply));
    await processAgentDispatchCallback(callback, {
      agentRunner: { run: rerun },
    });

    expect(rerun).not.toHaveBeenCalled();
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      attempt: 1,
      status: "completed",
    });
    const lifecycle = (
      await getConversationEventStore().loadHistory(
        getDispatchConversationId(created.record),
      )
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_completed",
      turnId: `dispatch:${created.record.id}`,
      outcome: "no_reply",
    });
  });

  it("fails the session record after delivering a failed dispatch fallback", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000006",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-fallback-completed",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const failedReply = createReply();
    const executeAgentRun = vi.fn(async () =>
      completedAgentRun({
        ...failedReply,
        text: "",
        diagnostics: {
          ...failedReply.diagnostics,
          errorMessage: "provider failed",
          outcome: "provider_error" as const,
          usedPrimaryText: false,
        },
        piMessages: failedDispatchPiMessages(),
      }),
    );

    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun } },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "failed",
      resultMessageTs: "1700000000.000006",
    });
    await expect(
      getAgentTurnSessionRecord(
        dispatchConversationId,
        `dispatch:${created.record.id}`,
      ),
    ).resolves.toMatchObject({
      conversationId: dispatchConversationId,
      sessionId: `dispatch:${created.record.id}`,
      state: "failed",
      surface: "api",
    });
    const lifecycle = (
      await getConversationEventStore().loadHistory(dispatchConversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.at(-1)?.data).toMatchObject({
      type: "turn_failed",
      turnId: `dispatch:${created.record.id}`,
      failureCode: "model_execution_failed",
      eventId: expect.any(String),
    });
  });

  it("suppresses re-posting when a redelivered slice finds the delivered marker", async () => {
    queueSlackApiResponse("chat.postMessage", {
      body: chatPostMessageOk({
        channel: "C123",
        ts: "1700000000.000005",
      }),
    });
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-crash-window",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: async () => completedAgentRun(createReply()) } },
    );
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000005",
    });

    // Simulate a crash after the delivered marker persisted but before the
    // dispatch was marked terminal: the record reverts to a lease-expired
    // running attempt that queue redelivery will re-claim.
    const reverted = await withDispatchLock(
      created.record.id,
      async (state) => {
        const current = parseDispatchRecord(
          await state.get(getDispatchStorageKey(created.record.id)),
        );
        if (!current) {
          throw new Error("Expected dispatch record");
        }
        return await updateDispatchRecord(state, {
          ...current,
          status: "running",
          attempt: 1,
          leaseExpiresAtMs: Date.now() - 1,
        });
      },
    );

    const rerunGenerate = vi.fn(async () => {
      throw new Error("must not regenerate a delivered dispatch");
    });
    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: reverted.version,
      },
      { agentRunner: { run: rerunGenerate } },
    );

    expect(rerunGenerate).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000005",
    });
  });

  it("records a persistence failure when a delivered marker has no lifecycle terminal", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-delivered-without-terminal",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const conversationId = getDispatchConversationId(created.record);
    const conversation = coerceThreadConversationState({});
    conversation.messages.push(
      {
        id: `dispatch:${created.record.id}:user`,
        role: "user",
        text: "Run the scheduled task.",
        createdAtMs: Date.parse("2026-05-26T12:00:00.000Z"),
        author: { userName: "system:scheduler", isBot: true },
        meta: { replied: true },
      },
      {
        id: `assistant:dispatch:${created.record.id}`,
        role: "assistant",
        text: "A delivered fallback whose model outcome is unknown.",
        createdAtMs: Date.parse("2026-05-26T12:00:01.000Z"),
        author: { userName: "junior", isBot: true },
        meta: {
          replied: true,
          slackTs: "1700000000.000007",
        },
      },
    );
    await persistConversationMessages({ conversation, conversationId });

    const rerunGenerate = vi.fn(async () => {
      throw new Error("must not regenerate a delivered dispatch");
    });
    await processAgentDispatchCallback(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: rerunGenerate } },
    );

    expect(rerunGenerate).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(0);
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000007",
    });
    const lifecycle = (
      await getConversationEventStore().loadHistory(conversationId)
    ).filter((event) => event.data.type.startsWith("turn_"));
    expect(lifecycle.map((event) => event.data)).toEqual([
      {
        type: "turn_started",
        turnId: `dispatch:${created.record.id}`,
        inputMessageIds: [`dispatch:${created.record.id}:user`],
        surface: "api",
      },
      {
        type: "turn_failed",
        turnId: `dispatch:${created.record.id}`,
        failureCode: "persistence_failed",
      },
    ]);
  });

  it("does not burn an attempt when the destination conversation is busy", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-busy",
        destination: slackAddress(),
        destinationVisibility: "private",
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const state = getStateAdapter();
    await state.connect();
    const lock = await state.acquireLock(
      getDispatchDestinationLockId(created.record.destination),
      5 * 60 * 1000,
    );
    expect(lock).toBeTruthy();

    try {
      await processAgentDispatchCallback(
        {
          id: created.record.id,
          expectedVersion: created.record.version,
        },
        {
          agentRunner: {
            run: async () => {
              throw new Error("busy conversation should not run");
            },
          },
        },
      );
    } finally {
      if (lock) {
        await state.releaseLock(lock);
      }
    }

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      attempt: 0,
      errorMessage: "Destination conversation is busy",
      status: "pending",
    });
  });
});
