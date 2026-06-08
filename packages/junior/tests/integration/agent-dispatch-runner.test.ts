import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrGetDispatch,
  getDispatchConversationId,
  getDispatchDestinationLockId,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { runAgentDispatchSlice } from "@/chat/agent-dispatch/runner";
import {
  getPersistedThreadState,
  persistThreadStateById,
} from "@/chat/runtime/thread-state";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { coerceThreadConversationState } from "@/chat/state/conversation";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { AssistantReply } from "@/chat/respond";
import {
  bindSlackDirectCredentialSubject,
  createSlackDirectCredentialSubject,
} from "@/chat/credentials/subject";
import { chatPostMessageOk } from "../fixtures/slack/factories/api";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

vi.hoisted(() => {
  process.env.JUNIOR_STATE_ADAPTER = "memory";
});

function createReply(): AssistantReply {
  return {
    text: "Dispatch delivered.",
    deliveryMode: "thread",
    deliveryPlan: {
      mode: "thread",
      postThreadText: true,
      attachFiles: "none",
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
  };
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
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
        metadata: { runId: "run-1" },
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const generateAssistantReply = vi.fn(async (_input, context) => {
      expect(context.requester).toBeUndefined();
      expect(context.authorizationFlowMode).toBe("disabled");
      expect(context.correlation).toMatchObject({
        conversationId: dispatchConversationId,
        threadId: dispatchConversationId,
        channelId: "C123",
        teamId: "T123",
      });
      expect(context.credentialContext).toEqual({
        actor: { type: "system", id: "scheduler" },
      });
      return createReply();
    });

    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { generateAssistantReply },
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
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
        metadata: { runId: "run-isolated-context" },
      },
    });
    const dispatchConversationId = getDispatchConversationId(created.record);
    const generateAssistantReply = vi.fn(async (_input, context) => {
      expect(context.conversationContext).toBeUndefined();
      expect(context.piMessages).toEqual([]);
      return createReply();
    });

    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { generateAssistantReply },
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

  it("persists agent continuation state before scheduling the next slice", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-timeout",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
      },
    });
    const scheduleCallback = vi.fn(async () => undefined);
    const generateAssistantReply = vi.fn(async () => {
      throw new RetryableTurnError("agent_continue", "slice timed out", {
        version: 7,
        sliceId: 2,
      });
    });

    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { generateAssistantReply, scheduleCallback },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "awaiting_resume",
    });
    expect(scheduleCallback).toHaveBeenCalledWith({
      id: created.record.id,
      expectedVersion: expect.any(Number),
    });
  });

  it("passes delegated credential subjects without changing the requester actor", async () => {
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
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "D123",
        },
        input: "Run the scheduled task.",
      },
    });
    const generateAssistantReply = vi.fn(async (_input, context) => {
      expect(context.requester).toBeUndefined();
      expect(context.credentialContext).toEqual({
        actor: { type: "system", id: "scheduler" },
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
      return createReply();
    });

    await runAgentDispatchSlice(
      {
        id: created.record.id,
        expectedVersion: created.record.version,
      },
      { generateAssistantReply },
    );

    await expect(getDispatchRecord(created.record.id)).resolves.toMatchObject({
      status: "completed",
      resultMessageTs: "1700000000.000002",
    });
  });

  it("does not burn an attempt when the destination conversation is busy", async () => {
    const created = await createOrGetDispatch({
      plugin: "scheduler",
      nowMs: Date.parse("2026-05-26T12:00:00.000Z"),
      options: {
        idempotencyKey: "run-busy",
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
        },
        input: "Run the scheduled task.",
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
          generateAssistantReply: async () => {
            throw new Error("busy conversation should not run");
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
