import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wakePausedTurn } from "@/chat/task-execution/turn-wake";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  getTurnRecord,
  upsertTurnRecord,
} from "@/chat/task-execution/turn-cursor";
import { persistThreadStateById } from "@/chat/runtime/thread-state";
import { createSlackSource } from "@sentry/junior-plugin-api";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";

function slackSessionSource(threadTs: string) {
  return createSlackSource({
    teamId: SLACK_DESTINATION.teamId,
    channelId: SLACK_DESTINATION.channelId,
    threadTs,
    visibility: "private",
  });
}

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

describe("paused turn scheduling", () => {
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

  it("marks paused turns runnable and wakes the durable queue", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const conversationId = "slack:C123:1712345.0001";

    await wakePausedTurn(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        turnId: "turn_msg_1",
        expectedVersion: 3,
      },
      { queue, nowMs: 1_000 },
    );

    expect(queue.sentRecords()).toEqual([
      {
        conversationId,
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

    await wakePausedTurn(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        turnId: "turn_msg_1",
        expectedVersion: 3,
      },
      { queue, nowMs: 1_000 },
    );
    queue.clearSentRecords();

    await wakePausedTurn(
      {
        conversationId,
        destination: SLACK_DESTINATION,
        turnId: "turn_msg_1",
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

  it("queue continue does not take a second resume lock", async () => {
    const conversationId = "slack:C123:1712345.0002";
    const state = getStateAdapter();
    await state.connect();
    // Hold the old thread lock. Queue continue must still run — it owns the
    // conversation work lease only, not a second resume lock.
    const lock = await state.acquireLock(conversationId, 90_000);
    expect(lock).toBeTruthy();
    const resumeTurn = vi.fn().mockResolvedValue(false);
    const { runPausedTurn } = await import("@/chat/task-execution/paused-turn");

    await expect(
      runPausedTurn(
        {
          conversationId,
          destination: SLACK_DESTINATION,
          turnId: "turn_msg_2",
          expectedVersion: 1,
        },
        {
          agentRunner: agentRunnerShouldNotRun,
          resumeTurn,
        },
      ),
    ).resolves.toBe(false);

    expect(resumeTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId,
        turnId: "turn_msg_2",
        ownsConversationLease: true,
      }),
    );
    if (lock) {
      await state.releaseLock(lock);
    }
  });

  it("fails a running turn only after exclusive ownership is available", async () => {
    const { runNextPausedTurn } =
      await import("@/chat/task-execution/paused-turn");
    const conversationId = "slack:C123:1712345.0006";
    const turnId = "turn_msg_6";
    const state = getStateAdapter();
    await state.connect();

    await upsertTurnRecord({
      conversationId,
      turnId: turnId,
      sliceId: 1,
      state: "running",
      destination: SLACK_DESTINATION,
      source: slackSessionSource("1712345.0006"),
      piMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "original request" }],
          timestamp: 1_000,
        },
      ],
    });
    await persistThreadStateById(conversationId, {
      conversation: {
        schemaVersion: 1,
        compactions: [],
        messages: [
          {
            id: "1712345.0006",
            role: "user",
            text: "original request",
            createdAtMs: 1_000,
            author: { userId: "U123" },
          },
        ],
        processing: { activeTurnId: turnId },
        vision: { byFileId: {} },
      },
    });

    const owner = await state.acquireLock(conversationId, 90_000);
    expect(owner).toBeTruthy();
    await runNextPausedTurn(conversationId, {
      agentRunner: agentRunnerShouldNotRun,
    });
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      state: "running",
    });

    await state.releaseLock(owner!);
    await runNextPausedTurn(conversationId, {
      agentRunner: agentRunnerShouldNotRun,
    });
    await expect(getTurnRecord(conversationId, turnId)).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Turn lost its worker before reaching a safe boundary",
    });
  });

  it("fails continuation summaries whose metadata cannot materialize", async () => {
    const { runNextPausedTurn } =
      await import("@/chat/task-execution/paused-turn");
    const conversationId = "slack:C123:1712345.0003";

    await upsertTurnRecord({
      conversationId,
      turnId: "turn_msg_3",
      sliceId: 1,
      state: "paused",
      destination: SLACK_DESTINATION,
      resumeReason: "timeout",
      piMessages: [],
    });

    await expect(
      runNextPausedTurn(conversationId, {
        agentRunner: agentRunnerShouldNotRun,
      }),
    ).resolves.toBe(false);
    await expect(
      getTurnRecord(conversationId, "turn_msg_3"),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Awaiting paused-turn metadata could not be materialized",
    });
  });

  it("resumes delivery retries with the supplied runner", async () => {
    const { runNextPausedTurn } =
      await import("@/chat/task-execution/paused-turn");
    const conversationId = "slack:C123:1712345.0005";
    const generateReply = vi.fn();
    const resumeTurn = vi.fn(async () => true);

    await upsertTurnRecord({
      conversationId,
      turnId: "turn_msg_5",
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: slackSessionSource("1712345.0005"),
      resumeReason: "retry",
      piMessages: [],
    });

    await expect(
      runNextPausedTurn(conversationId, {
        agentRunner: { run: generateReply },
        resumeTurn,
      }),
    ).resolves.toBe(true);

    expect(resumeTurn).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunner: { run: generateReply } }),
    );
  });

  it("fails stale continuations skipped during resume startup", async () => {
    const { runNextPausedTurn } =
      await import("@/chat/task-execution/paused-turn");
    const conversationId = "slack:C123:1712345.0004";
    const sessionId = "turn_1712345_0004";

    await upsertTurnRecord({
      conversationId,
      turnId: sessionId,
      sliceId: 2,
      state: "paused",
      destination: SLACK_DESTINATION,
      source: slackSessionSource("1712345.0004"),
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
      conversation: {
        schemaVersion: 1,
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
        vision: {
          byFileId: {},
        },
      },
    });

    await expect(
      runNextPausedTurn(conversationId, {
        agentRunner: agentRunnerShouldNotRun,
      }),
    ).resolves.toBe(false);
    await expect(
      getTurnRecord(conversationId, sessionId),
    ).resolves.toMatchObject({
      state: "failed",
      errorMessage: "Awaiting paused turn was stale before it could run",
    });
  });
});
