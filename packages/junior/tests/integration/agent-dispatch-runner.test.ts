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
import { runAgentDispatchSlice } from "@/chat/agent-dispatch/runner";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { AgentRunResult } from "@/chat/services/turn-result";
import type { PiMessage } from "@/chat/pi/messages";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import {
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
} from "../msw/handlers/slack-api";
import { flattenAgentRunRequestForTest } from "../fixtures/agent-runner";

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

    await runAgentDispatchSlice(
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
    await expect(
      getPersistedThreadState(dispatchConversationId),
    ).resolves.toMatchObject({
      conversation: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: `dispatch:${created.record.id}:user`,
            author: expect.objectContaining({
              userName: "system:scheduler",
              isBot: true,
            }),
          }),
          expect.objectContaining({
            id: `dispatch:${created.record.id}:assistant`,
            meta: expect.objectContaining({
              slackTs: "1700000000.000001",
              replied: true,
            }),
          }),
        ]),
      },
    });
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
    await expect(getPersistedThreadState("slack:T123:C123")).resolves.toEqual(
      {},
    );
  });

  it("starts dispatches without inherited destination conversation memory", async () => {
    const destinationConversation = coerceThreadConversationState({
      conversation: {
        messages: [
          {
            id: "channel-message-1",
            role: "user",
            text: "Previous scheduled run failed with stale context.",
            createdAtMs: Date.parse("2026-05-25T12:00:00.000Z"),
            author: { userName: "alice" },
          },
        ],
      },
    });
    await persistThreadStateById("slack:T123:C123", {
      conversation: destinationConversation,
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

    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun } },
    );

    const persistedDestination =
      await getPersistedThreadState("slack:T123:C123");
    expect(
      coerceThreadConversationState(persistedDestination).messages.map(
        (message) => message.id,
      ),
    ).toEqual(["channel-message-1"]);
    await expect(
      getPersistedThreadState(dispatchConversationId),
    ).resolves.toMatchObject({
      conversation: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: `dispatch:${created.record.id}:user`,
          }),
          expect.objectContaining({
            id: `dispatch:${created.record.id}:assistant`,
          }),
        ]),
      },
    });
  });

  it("does not persist visible filler text for side-effect-only dispatches", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-side-effect-only",
        destination: slackAddress(),
        input: "React to the scheduled thread.",
        source: slackSource(),
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const sideEffectReply = createReply();

    await runAgentDispatchSlice(
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
    await expect(
      getPersistedThreadState(dispatchConversationId),
    ).resolves.toMatchObject({
      conversation: {
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: `dispatch:${created.record.id}:assistant`,
            text: "[empty response]",
          }),
        ]),
      },
    });
  });

  it("persists agent continuation state before scheduling the next slice", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-timeout",
        destination: slackAddress(),
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    const scheduleCallback = vi.fn(async () => undefined);
    const executeAgentRun = vi.fn(async () => {
      return { status: "suspended" as const, resumeVersion: 7 };
    });

    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: executeAgentRun }, scheduleCallback },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "awaiting_resume",
    });
    expect(scheduleCallback).toHaveBeenCalledWith({
      id: created.record.id,
      expectedVersion: expect.any(Number),
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

    await runAgentDispatchSlice(
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
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
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

    try {
      await runAgentDispatchSlice(
        {
          id: created.record.id,
          expectedVersion: created.record.version,
        },
        {
          agentRunner: { run: async () => completedAgentRun(createReply()) },
        },
      );
    } finally {
      setSpy.mockRestore();
    }

    // Delivery already happened: the dispatch is terminal so a retry cannot
    // re-post, and the persistence failure is logged instead of failing it.
    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000004",
    });

    const rerunGenerate = vi.fn(async () => {
      throw new Error("must not regenerate a delivered dispatch");
    });
    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { agentRunner: { run: rerunGenerate } },
    );
    expect(rerunGenerate).not.toHaveBeenCalled();
    expect(getCapturedSlackApiCalls("chat.postMessage")).toHaveLength(1);
  });

  it("completes the session record after delivering a failed dispatch fallback", async () => {
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

    await runAgentDispatchSlice(
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
      state: "completed",
      surface: "api",
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
        input: "Run the scheduled task.",
        source: slackSource(),
      },
    });
    await runAgentDispatchSlice(
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
    await runAgentDispatchSlice(
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

  it("does not burn an attempt when the destination conversation is busy", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-busy",
        destination: slackAddress(),
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
      await runAgentDispatchSlice(
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
