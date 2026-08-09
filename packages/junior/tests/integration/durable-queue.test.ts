import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import type { PiMessage } from "@/chat/pi/messages";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_RETRIES,
  countPendingConversationMessages,
  ensureConversationWake,
  getConversationWorkState,
  requestConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  getTurnRecord,
  loadTurnCheckpoint,
  saveTurnCheckpoint,
} from "@/chat/task-execution/checkpoint";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import type {
  ConversationWorkerContext,
  ConversationWorkerResult,
} from "@/chat/task-execution/worker";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
  inboundMessage,
} from "../fixtures/conversation-work";

interface RunFault {
  at: "before_ack";
  error?: Error;
}

type RunStep = ConversationWorkerResult | RunFault;

/** Real queue/state/worker wiring with faults injected only at the work boundary. */
async function createHarness(steps: RunStep[]) {
  const state = getStateAdapter();
  await state.connect();
  const queue = createConversationWorkQueueTestAdapter();
  const attempts: string[][] = [];
  let stepIndex = 0;

  const run = async (
    context: ConversationWorkerContext,
  ): Promise<ConversationWorkerResult> => {
    attempts.push(
      context.attempt.messages.map((message) => message.inboundMessageId),
    );
    const step = steps[stepIndex] ?? steps.at(-1);
    stepIndex += 1;
    if (!step) {
      throw new Error("Durable queue harness ran without a scripted outcome");
    }
    if ("at" in step) {
      if (step.error) {
        throw step.error;
      }
      return { status: "completed" };
    }
    await context.attempt.ack();
    return step;
  };

  const enqueue = async (id = "message-1") => {
    await appendAndEnqueueInboundMessage({
      message: inboundMessage(id),
      queue,
      state,
    });
  };

  const runNext = async () =>
    await processConversationQueueMessage(queue.takeMessage(), {
      queue,
      run,
      state,
    });

  const work = async () =>
    await getConversationWorkState({ conversationId: CONVERSATION_ID, state });

  return { attempts, enqueue, queue, runNext, state, work };
}

function crashedBeforeAck(message: string): RunFault {
  return { at: "before_ack", error: new Error(message) };
}

function returnedBeforeAck(): RunFault {
  return { at: "before_ack" };
}

function userMessage(text: string, timestamp: number): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function toolHistory(): PiMessage[] {
  return [
    userMessage("inspect the deploy", 1),
    {
      role: "assistant",
      content: [
        { type: "text", text: "checking" },
        {
          type: "toolCall",
          id: "call-1",
          name: "bash",
          arguments: { command: "echo ok" },
        },
      ],
      api: "responses",
      provider: "openai",
      model: "test-model",
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
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    },
  ] as PiMessage[];
}

describe("durable queue", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("drains one durable mailbox attempt under a lease", async () => {
    const harness = await createHarness([{ status: "completed" }]);

    await harness.enqueue();
    await expect(harness.runNext()).resolves.toEqual({ status: "completed" });

    const work = await harness.work();
    expect(harness.attempts).toEqual([["message-1"]]);
    expect(harness.queue.sentRecords()).toHaveLength(1);
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(false);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("retries an unacknowledged attempt and processes it once", async () => {
    const harness = await createHarness([
      returnedBeforeAck(),
      { status: "completed" },
    ]);

    await harness.enqueue();
    await expect(harness.runNext()).resolves.toEqual({
      status: "pending_requeued",
    });
    expect(await harness.work()).toMatchObject({
      needsRun: true,
      messages: [expect.objectContaining({ inboundMessageId: "message-1" })],
    });

    await expect(harness.runNext()).resolves.toEqual({ status: "completed" });
    expect(harness.attempts).toEqual([["message-1"], ["message-1"]]);
    expect((await harness.work())?.needsRun).toBe(false);
  });

  it("fails a resumed turn that parks at the same SQL boundary", async () => {
    const turnId = "turn-stuck";
    const original = toolHistory();
    await saveTurnCheckpoint({
      mode: "paused",
      reason: "timeout",
      conversationId: CONVERSATION_ID,
      turnId,
      sliceId: 1,
      modelId: "test-model",
      messages: original,
    });
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });

    const queue = createConversationWorkQueueTestAdapter();
    await ensureConversationWake({
      conversationId: CONVERSATION_ID,
      idempotencyKey: "stuck-turn",
      queue,
    });
    const state = getStateAdapter();
    const attempts: string[][] = [];
    const run = async (
      context: ConversationWorkerContext,
    ): Promise<ConversationWorkerResult> => {
      attempts.push(
        context.attempt.messages.map((message) => message.inboundMessageId),
      );
      const checkpoint = await loadTurnCheckpoint({
        conversationId: CONVERSATION_ID,
        turnId,
      });
      if (checkpoint.record?.state === "failed") {
        return { status: "completed" };
      }
      const resume = createResumeState({
        destination: SLACK_DESTINATION,
        durability: {},
        getLoadedSkillNames: () => [],
        getModelId: () => "test-model",
        getReasoningLevel: () => undefined,
        recordActiveMcpProviders: async () => undefined,
        runSource: createSlackSource({
          teamId: SLACK_DESTINATION.teamId,
          channelId: SLACK_DESTINATION.channelId,
          visibility: "private",
        }),
        conversationId: CONVERSATION_ID,
        turnId,
        checkpoint,
        startedAtMs: Date.now(),
        surface: "slack",
      });
      const mutated = checkpoint.record!.piMessages.map((message) =>
        message.role === "assistant"
          ? {
              ...message,
              usage: {
                ...(message.usage ?? {}),
                output: 99,
                totalTokens: 100,
              },
              stopReason: "toolUse" as const,
            }
          : message,
      );
      await resume.persistSafeBoundary(mutated);
      resume.captureResumeSnapshot(mutated);
      resume.markTimedOut();
      await resume.translateSuspension({ error: new Error("timed out") });
      return { status: "completed" };
    };

    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(attempts).toEqual([[]]);
    expect(queue.queuedMessages()).toHaveLength(1);
    await expect(
      processConversationQueueMessage(queue.takeMessage(), {
        queue,
        run,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });
    expect(attempts).toEqual([[], []]);
    expect(queue.hasQueuedMessages()).toBe(false);
    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject({
      state: "failed",
      errorMessage:
        "Turn made no progress: continue parked at the same boundary",
    });
  });

  it("records an unexpected worker-boundary crash for recovery", async () => {
    const harness = await createHarness([
      crashedBeforeAck("worker boundary crashed"),
    ]);

    await harness.enqueue();
    await expect(harness.runNext()).resolves.toEqual({ status: "failed" });

    const work = await harness.work();
    expect(harness.attempts).toEqual([["message-1"]]);
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work?.execution.retryCount).toBe(1);
  });

  it("recovers an expired lease with one replacement wake", async () => {
    const harness = await createHarness([{ status: "completed" }]);
    await harness.enqueue();
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state: harness.state,
    });
    expect(lease.status).toBe("acquired");

    harness.queue.clearSentRecords();
    await expect(
      recoverConversationWork({
        nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue: harness.queue,
        state: harness.state,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
    expect(harness.queue.sentRecords()).toHaveLength(1);

    await expect(harness.runNext()).resolves.toEqual({ status: "completed" });
    expect(harness.attempts).toEqual([["message-1"], []]);
    expect((await harness.work())?.needsRun).toBe(false);
  });

  it("stops retrying a permanently failing attempt", async () => {
    const harness = await createHarness([returnedBeforeAck()]);
    await harness.enqueue();

    const results: string[] = [];
    while (harness.queue.hasQueuedMessages()) {
      const result = await harness.runNext();
      results.push(result.status);
      if (result.status === "failed") {
        break;
      }
      expect(results.length).toBeLessThanOrEqual(
        CONVERSATION_WORK_MAX_RETRIES + 1,
      );
    }

    expect(results.at(-1)).toBe("failed");
    expect(harness.attempts).toHaveLength(CONVERSATION_WORK_MAX_RETRIES);
    const work = await harness.work();
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(false);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });
});
