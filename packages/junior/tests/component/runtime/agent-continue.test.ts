import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getAgentTurnSessionRecord,
  upsertAgentTurnSessionRecord,
} from "@/chat/state/turn-session";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";

const ORIGINAL_ENV = vi.hoisted(() => {
  const original = {
    JUNIOR_STATE_ADAPTER: process.env.JUNIOR_STATE_ADAPTER,
  };
  process.env.JUNIOR_STATE_ADAPTER = "memory";
  return original;
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

const agentRunnerShouldNotRun = neverRunAgentRunner();

describe("agent continuation scheduling", () => {
  beforeEach(async () => {
    process.env.JUNIOR_STATE_ADAPTER = "memory";
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await disconnectStateAdapter();
    restoreEnv("JUNIOR_STATE_ADAPTER", ORIGINAL_ENV.JUNIOR_STATE_ADAPTER);
    vi.restoreAllMocks();
  });

  it("marks agent continuations runnable and wakes the durable queue", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";

    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId: "turn_msg_1",
        expectedVersion: 3,
      },
      { queue, nowMs: 1_000 },
    );

    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
        destination: SLACK_DESTINATION,
        idempotencyKey: `agent-continue:${conversationId}:turn_msg_1:3:1000`,
      },
    ]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      destination: SLACK_DESTINATION,
      needsRun: true,
      lastEnqueuedAtMs: 1_000,
    });
  });

  it("coalesces continuation wakes while an accepted nudge is recent", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";

    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId: "turn_msg_1",
        expectedVersion: 3,
      },
      { queue, nowMs: 1_000 },
    );
    queue.clearSentRecords();

    await scheduleAgentContinue(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId: "turn_msg_1",
        expectedVersion: 4,
      },
      { queue, nowMs: 2_000 },
    );

    expect(queue.sentRecords()).toEqual([]);
    await expect(
      getConversationWorkState({ conversationId }),
    ).resolves.toMatchObject({
      conversationId,
      needsRun: true,
      lastEnqueuedAtMs: 1_000,
    });
  });

  it("reschedules continuation when the Slack resume lock stays busy", async () => {
    vi.useFakeTimers();
    const conversationId = "slack:C123:1712345.0002";
    const state = getStateAdapter();
    await state.connect();
    const lock = await state.acquireLock(conversationId, 90_000);
    expect(lock).toBeTruthy();
    const scheduleAgentContinue = vi.fn().mockResolvedValue(undefined);
    const { continueSlackAgentRunWithLockRetry } =
      await import("@/chat/runtime/agent-continue-runner");

    const continued = continueSlackAgentRunWithLockRetry(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        sessionId: "turn_msg_2",
        expectedVersion: 1,
      },
      { agentRunner: agentRunnerShouldNotRun, scheduleAgentContinue },
    );

    await vi.advanceTimersByTimeAsync(4_000);
    await expect(continued).resolves.toBe(true);
    expect(scheduleAgentContinue).toHaveBeenCalledWith({
      conversationId,
      destination: SLACK_DESTINATION,
      sessionId: "turn_msg_2",
      expectedVersion: 1,
    });
    if (lock) {
      await state.releaseLock(lock);
    }
  });

  it("fails continuation summaries whose metadata cannot materialize", async () => {
    const { resumeAwaitingSlackContinuation } =
      await import("@/chat/runtime/agent-continue-runner");
    const conversationId = "slack:C123:1712345.0003";

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: "turn_msg_3",
      sliceId: 1,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      piMessages: [],
    });

    await expect(
      resumeAwaitingSlackContinuation(conversationId, {
        agentRunner: agentRunnerShouldNotRun,
      }),
    ).resolves.toBe(false);
    await expect(
      getAgentTurnSessionRecord(conversationId, "turn_msg_3"),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Awaiting agent continuation metadata could not be materialized",
    });
  });

  it("passes runner options into awaiting continuations", async () => {
    const { resumeAwaitingSlackContinuation } =
      await import("@/chat/runtime/agent-continue-runner");
    const conversationId = "slack:C123:1712345.0005";
    const generateReply = vi.fn();
    const resumeTurn = vi.fn(async () => true);

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId: "turn_msg_5",
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      piMessages: [],
    });

    await expect(
      resumeAwaitingSlackContinuation(conversationId, {
        agentRunner: { run: generateReply },
        resumeTurn,
      }),
    ).resolves.toBe(true);

    expect(resumeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunner: { run: generateReply } }),
    );
  });

  it("fails stale continuations skipped during resume startup", async () => {
    const { resumeAwaitingSlackContinuation } =
      await import("@/chat/runtime/agent-continue-runner");
    const conversationId = "slack:C123:1712345.0004";
    const sessionId = "turn_1712345_0004";

    await upsertAgentTurnSessionRecord({
      conversationId,
      sessionId,
      sliceId: 2,
      state: "awaiting_resume",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "original request" }],
          timestamp: 1_000,
        },
      ],
    });
    await persistThreadStateById(conversationId, {
      artifacts: {
        listColumnMap: {},
      },
      conversation: {
        schemaVersion: 1,
        backfill: {},
        compactions: [],
        messages: [
          {
            id: "1712345.0004",
            role: "user",
            text: "original request",
            createdAtMs: 1_000,
            author: {
              userId: "U123",
            },
          },
        ],
        processing: {
          activeTurnId: "turn-newer",
        },
        stats: {
          compactedMessageCount: 0,
          estimatedContextTokens: 0,
          totalMessageCount: 1,
          updatedAtMs: 1_000,
        },
        vision: {
          byFileId: {},
        },
      },
    });

    await expect(
      resumeAwaitingSlackContinuation(conversationId, {
        agentRunner: agentRunnerShouldNotRun,
      }),
    ).resolves.toBe(false);
    await expect(
      getAgentTurnSessionRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Awaiting agent continuation was stale before it could run",
    });
  });
});
