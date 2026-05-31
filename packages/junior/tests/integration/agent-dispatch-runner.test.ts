import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOrGetDispatch,
  getDispatchRecord,
} from "@/chat/agent-dispatch/store";
import { runAgentDispatchSlice } from "@/chat/agent-dispatch/runner";
import { getPersistedThreadState } from "@/chat/runtime/thread-state";
import { RetryableTurnError } from "@/chat/runtime/turn";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { AssistantReply } from "@/chat/respond";
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

describe("agent dispatch runner", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
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
    const generateAssistantReply = vi.fn(async (_input, context) => {
      expect(context.requester).toBeUndefined();
      expect(context.authorizationFlowMode).toBe("disabled");
      expect(context.correlation).toMatchObject({
        conversationId: "slack:T123:C123",
        channelId: "C123",
        teamId: "T123",
        actorType: "system",
        actorId: "scheduler",
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
      getPersistedThreadState("slack:T123:C123"),
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
  });

  it("persists timeout resume state before scheduling the next slice", async () => {
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
      throw new RetryableTurnError("turn_timeout_resume", "slice timed out", {
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
        credentialSubject: {
          type: "user",
          userId: "U123",
          allowedWhen: "private-direct-conversation",
        },
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
      expect(context.credentialSubject).toEqual({
        type: "user",
        userId: "U123",
        allowedWhen: "private-direct-conversation",
      });
      expect(context.authorizationFlowMode).toBe("disabled");
      expect(context.correlation).toMatchObject({
        actorType: "system",
        actorId: "scheduler",
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
    const lock = await state.acquireLock("slack:T123:C123", 5 * 60 * 1000);
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
