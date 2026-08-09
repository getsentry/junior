import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createResumeState } from "@/chat/agent/resume";
import type { PiMessage } from "@/chat/pi/messages";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_RETRIES,
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

type Step = "ack" | "no-ack" | Error;
type Run = (
  work: ConversationWorkerContext,
) => Promise<ConversationWorkerResult>;

/** Exercise the real queue, state, lease, and worker with one injectable boundary. */
async function queue(script: Step[] | Run = ["ack"]) {
  const state = getStateAdapter();
  await state.connect();
  const wakes = createConversationWorkQueueTestAdapter();
  const attempts: string[][] = [];
  let index = 0;

  const run: Run = async (work) => {
    attempts.push(
      work.attempt.messages.map((message) => message.inboundMessageId),
    );
    if (typeof script === "function") return await script(work);
    const step = script[index++] ?? script.at(-1);
    if (!step) throw new Error("missing queue step");
    if (step instanceof Error) throw step;
    if (step === "ack") await work.attempt.ack();
    return { status: "completed" };
  };

  return {
    attempts,
    wakes,
    state,
    send: async () =>
      await appendAndEnqueueInboundMessage({
        message: inboundMessage("message-1"),
        queue: wakes,
        state,
      }),
    next: async () =>
      await processConversationQueueMessage(wakes.takeMessage(), {
        queue: wakes,
        run,
        state,
      }),
    work: async () =>
      await getConversationWorkState({
        conversationId: CONVERSATION_ID,
        state,
      }),
  };
}

function history(): PiMessage[] {
  const assistant = fauxAssistantMessage("checking");
  assistant.timestamp = 2;
  assistant.content.push({
    type: "toolCall",
    id: "call-1",
    name: "bash",
    arguments: { command: "echo ok" },
  });
  return [
    {
      role: "user",
      content: [{ type: "text", text: "inspect the deploy" }],
      timestamp: 1,
    },
    assistant,
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 3,
    },
  ];
}

describe("durable queue", () => {
  beforeEach(disconnectStateAdapter);
  afterEach(disconnectStateAdapter);

  it("drains work once", async () => {
    const q = await queue();
    await q.send();

    await expect(q.next()).resolves.toEqual({ status: "completed" });
    expect(q.attempts).toEqual([["message-1"]]);
    expect(await q.work()).toMatchObject({ needsRun: false, messages: [] });
  });

  it("retries work that was not acknowledged", async () => {
    const q = await queue(["no-ack", "ack"]);
    await q.send();

    await expect(q.next()).resolves.toEqual({ status: "pending_requeued" });
    await expect(q.next()).resolves.toEqual({ status: "completed" });
    expect(q.attempts).toEqual([["message-1"], ["message-1"]]);
    expect((await q.work())?.needsRun).toBe(false);
  });

  it("stops the checkpoint loop from JUNIOR-62", async () => {
    const turnId = "turn-stuck";
    await saveTurnCheckpoint({
      mode: "paused",
      reason: "timeout",
      conversationId: CONVERSATION_ID,
      turnId,
      sliceId: 1,
      modelId: "test-model",
      messages: history(),
    });
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });

    const q = await queue(async () => {
      const checkpoint = await loadTurnCheckpoint({
        conversationId: CONVERSATION_ID,
        turnId,
      });
      if (checkpoint.record?.state === "failed") return { status: "completed" };

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
      const changed = checkpoint.record!.piMessages.map((message) =>
        message.role === "assistant"
          ? { ...message, usage: { ...message.usage, output: 99 } }
          : message,
      );
      await resume.persistSafeBoundary(changed);
      resume.captureResumeSnapshot(changed);
      resume.markTimedOut();
      await resume.translateSuspension({ error: new Error("timed out") });
      return { status: "completed" };
    });
    await ensureConversationWake({
      conversationId: CONVERSATION_ID,
      idempotencyKey: "stuck-turn",
      queue: q.wakes,
    });

    await expect(q.next()).resolves.toEqual({ status: "failed" });
    await expect(q.next()).resolves.toEqual({ status: "completed" });
    expect(q.wakes.hasQueuedMessages()).toBe(false);
    await expect(getTurnRecord(CONVERSATION_ID, turnId)).resolves.toMatchObject(
      {
        state: "failed",
        errorMessage: expect.stringContaining("made no progress"),
      },
    );
  });

  it("recovers an expired lease once", async () => {
    const q = await queue();
    await q.send();
    await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state: q.state,
    });
    q.wakes.clearSentRecords();

    await expect(
      recoverConversationWork({
        nowMs: 1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue: q.wakes,
        state: q.state,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
    await expect(q.next()).resolves.toEqual({ status: "completed" });
    expect(q.wakes.sentRecords()).toHaveLength(1);
    expect((await q.work())?.needsRun).toBe(false);
  });

  it("stops retrying", async () => {
    const q = await queue(["no-ack"]);
    await q.send();

    const results: string[] = [];
    while (q.wakes.hasQueuedMessages()) results.push((await q.next()).status);

    expect(results.at(-1)).toBe("failed");
    expect(q.attempts).toHaveLength(CONVERSATION_WORK_MAX_RETRIES);
    expect(await q.work()).toMatchObject({ needsRun: false, messages: [] });
  });
});
