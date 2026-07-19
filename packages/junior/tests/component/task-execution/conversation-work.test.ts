import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateAdapter } from "chat";
import { scheduleAgentContinue } from "@/chat/services/agent-continue";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  appendInboundMessage,
  checkInConversationWork,
  CONVERSATION_ACTIVE_INDEX_KEY,
  CONVERSATION_BY_ACTIVITY_INDEX_KEY,
  completeConversationWork,
  CONVERSATION_WORK_LEASE_TTL_MS,
  CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  listActiveConversationIds,
  listConversationsByActivity,
  ackMessages,
  recordConversationActivity,
  requestConversationContinuation,
  requestConversationWork,
  releaseConversationWork,
  startConversationWork,
  type InboundMessage,
} from "@/chat/task-execution/store";
import {
  deleteConversationState,
  recordConversationExecution,
} from "@/chat/task-execution/state";
import {
  CONVERSATION_WORK_DEFER_DELAY_MS,
  processConversationWork,
} from "@/chat/task-execution/worker";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import { closeDb } from "@/chat/db";
import type { ConversationStore } from "@/chat/conversations/store";
import {
  signConversationQueueMessage,
  verifySignedConversationQueueMessage,
} from "@/chat/task-execution/queue-signing";
import type { ConversationWorkQueue } from "@/chat/task-execution/queue";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
  acquireConversationMutationLock,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  deferred,
  delayIndexLockOnce,
  delayMutationLockUntil,
  inboundMessage,
  observeConversationMutationLock,
} from "../../fixtures/conversation-work";

const OTHER_SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C456",
} as const;
const CONVERSATION_WORK_STATE_KEY = `junior:conversation:${CONVERSATION_ID}`;

function failingMetadataStore(): ConversationStore {
  return {
    get: vi.fn(async () => undefined),
    getDestinationVisibility: vi.fn(async () => undefined),
    ensureChildConversation: vi.fn(async () => undefined),
    recordActivity: vi.fn(),
    recordExecution: vi.fn(async () => {
      throw new Error("metadata unavailable");
    }),
    listByActivity: vi.fn(async () => []),
  };
}

function metadataEventsStore(events: string[]): ConversationStore {
  return {
    get: vi.fn(async () => undefined),
    getDestinationVisibility: vi.fn(async () => undefined),
    ensureChildConversation: vi.fn(async () => undefined),
    recordActivity: vi.fn(),
    recordExecution: vi.fn(async () => {
      events.push("metadata");
    }),
    listByActivity: vi.fn(async () => []),
  };
}

describe("conversation work execution", () => {
  const originalJuniorSecret = process.env.JUNIOR_SECRET;

  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await closeDb();
    await disconnectStateAdapter();
    if (originalJuniorSecret === undefined) {
      delete process.env.JUNIOR_SECRET;
    } else {
      process.env.JUNIOR_SECRET = originalJuniorSecret;
    }
    vi.useRealTimers();
  });

  it("deletes a conversation mailbox and all index entries", async () => {
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await deleteConversationState({ conversationId: CONVERSATION_ID });

    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID }),
    ).resolves.toBeUndefined();
    await expect(listActiveConversationIds()).resolves.not.toContain(
      CONVERSATION_ID,
    );
    await expect(listConversationsByActivity()).resolves.not.toContainEqual(
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );
    await expect(
      appendInboundMessage({ message: inboundMessage("m1"), nowMs: 2_000 }),
    ).resolves.toEqual({ status: "appended" });
  });

  it("stores inbound mailbox messages idempotently without duplicate queue attempts", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).resolves.toMatchObject({ status: "appended", queueMessageId: "queue-1" });
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 3_000,
        queue,
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
    });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.execution.inboundMessageIds).toEqual(["m1"]);
    expect(state?.messages).toHaveLength(1);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(1);
    expect(queue.sendAttempts()).toHaveLength(1);
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("surfaces SQL metadata failure after preserving the queue wake-up", async () => {
    const queue = createConversationWorkQueueTestAdapter();

    await expect(
      appendAndEnqueueInboundMessage({
        conversationStore: failingMetadataStore(),
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).rejects.toThrow("metadata unavailable");

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages).toHaveLength(1);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
    ]);
  });

  it("sends queue wake-up before conversation metadata update", async () => {
    const events: string[] = [];
    const queue: ConversationWorkQueue = {
      send: vi.fn(async () => {
        events.push("queue");
        return { messageId: "queue-1" };
      }),
    };

    await expect(
      appendAndEnqueueInboundMessage({
        conversationStore: metadataEventsStore(events),
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).resolves.toMatchObject({ status: "appended", queueMessageId: "queue-1" });

    expect(events).toEqual(["queue", "metadata"]);
  });

  it("does not overwrite malformed persisted conversation work", async () => {
    const state = getStateAdapter();
    await state.connect();
    const legacyMessage = {
      ...(inboundMessage("legacy") as unknown as Record<string, unknown>),
    };
    delete legacyMessage.destination;
    const legacyWork = {
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      createdAtMs: 1_000,
      destination: SLACK_DESTINATION,
      execution: {
        pendingMessages: [legacyMessage],
      },
      lastActivityAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    await state.set(CONVERSATION_WORK_STATE_KEY, legacyWork);

    await expect(
      appendInboundMessage({
        message: inboundMessage("m2"),
        nowMs: 2_000,
        state,
      }),
    ).rejects.toThrow("Conversation record is invalid");

    await expect(state.get(CONVERSATION_WORK_STATE_KEY)).resolves.toEqual(
      legacyWork,
    );
  });

  it("repairs duplicate inbound work when no queue marker was recorded", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toMatchObject({
      status: "duplicate",
      queueMessageId: "queue-1",
    });

    expect(queue.sendAttempts()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `duplicate:${CONVERSATION_ID}:m1:62000`,
      },
    ]);
    expect(queue.sentRecords()).toEqual(queue.sendAttempts());
  });

  it("upgrades a still-pending twin payload that adds file attachments", async () => {
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    const twinWithFiles = inboundMessage("m1", {
      receivedAtMs: 2_000,
      input: {
        text: "message m1",
        authorId: "U123",
        attachments: [{ id: "F123" }],
        metadata: { platform: "slack", hasFiles: true },
      },
    });
    await expect(
      appendInboundMessage({ message: twinWithFiles, nowMs: 2_000 }),
    ).resolves.toEqual({ status: "duplicate" });

    let work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages).toEqual([
      expect.objectContaining({
        inboundMessageId: "m1",
        receivedAtMs: 1_100,
        input: expect.objectContaining({
          attachments: [{ id: "F123" }],
          metadata: { platform: "slack", hasFiles: true },
        }),
      }),
    ]);

    // A later attachment-less twin must not downgrade the stored payload.
    await expect(
      appendInboundMessage({ message: inboundMessage("m1"), nowMs: 3_000 }),
    ).resolves.toEqual({ status: "duplicate" });
    work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work?.messages[0]?.input.attachments).toEqual([{ id: "F123" }]);
  });

  it("retries transient conversation work index lock contention", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = delayIndexLockOnce(getStateAdapter());

    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
        state,
      }),
    ).resolves.toMatchObject({ status: "appended", queueMessageId: "queue-1" });

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("waits through same-conversation mutation lock contention", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const queue = createConversationWorkQueueTestAdapter();
    const state = delayMutationLockUntil({
      conversationId: CONVERSATION_ID,
      readyAtMs: 3_500,
      state: getStateAdapter(),
    });

    const append = appendAndEnqueueInboundMessage({
      message: inboundMessage("m1"),
      nowMs: 2_000,
      queue,
      state,
    });

    await vi.advanceTimersByTimeAsync(2_500);
    await expect(append).resolves.toMatchObject({
      status: "appended",
      queueMessageId: "queue-1",
    });
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("recovers an expired lease after the mutation lock ttl elapses", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();

    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state,
    });
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 1_000,
      state,
    });
    expect(lease.status).toBe("acquired");

    await vi.advanceTimersByTimeAsync(CONVERSATION_WORK_LEASE_TTL_MS + 1);

    const staleMutationLock = await acquireConversationMutationLock({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(staleMutationLock).not.toBeNull();

    const recoveryNowMs = Date.now() + 10_001;
    const recovery = recoverConversationWork({
      nowMs: recoveryNowMs,
      queue,
      state,
    });
    await vi.advanceTimersByTimeAsync(10_001);

    await expect(recovery).resolves.toEqual({
      expiredLeaseCount: 1,
      pendingCount: 0,
    });
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:lease:${CONVERSATION_ID}:${recoveryNowMs}`,
      }),
    ]);

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.lease).toBeUndefined();
    expect(recovered?.needsRun).toBe(true);
  });

  it("repairs pending mailbox work when the initial queue send fails", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    queue.rejectSends();
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).rejects.toThrow("queue unavailable");

    queue.allowSends();
    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}:62000`,
      },
    ]);
  });

  it("keeps stale active conversation ids when the active index exceeds the activity feed cap", async () => {
    const state = getStateAdapter();
    await state.connect();
    const staleConversationId = "conversation-stale";
    await state.set(
      CONVERSATION_ACTIVE_INDEX_KEY,
      Array.from({ length: 10_000 }, (_, index) => ({
        conversationId: `newer-${index}`,
        score: 10_000 + index,
      })),
      60_000,
    );

    await requestConversationWork({
      conversationId: staleConversationId,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state,
    });

    const ids = await listActiveConversationIds({ state });
    expect(ids).toContain(staleConversationId);
    expect(ids).toHaveLength(10_001);

    await expect(
      listActiveConversationIds({ staleBeforeMs: 1_000, state }),
    ).resolves.toEqual([staleConversationId]);
  });

  it("normalizes malformed emulated conversation indexes", async () => {
    const state = getStateAdapter();
    await state.connect();
    await state.set(CONVERSATION_ACTIVE_INDEX_KEY, "not-an-index", 60_000);
    await state.set(CONVERSATION_BY_ACTIVITY_INDEX_KEY, "not-an-index", 60_000);

    await expect(listActiveConversationIds({ state })).resolves.toEqual([]);
    await expect(
      listConversationsByActivity({ state, limit: 10 }),
    ).resolves.toEqual([]);
  });

  it("keeps pending mailbox records in the active index after activity refresh", async () => {
    const state = getStateAdapter();
    await state.connect();
    const pendingMessage = inboundMessage("m1");
    await state.set(CONVERSATION_WORK_STATE_KEY, {
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      createdAtMs: 1_000,
      destination: SLACK_DESTINATION,
      execution: {
        inboundMessageIds: [pendingMessage.inboundMessageId],
        pendingCount: 1,
        pendingMessages: [pendingMessage],
        status: "idle",
        updatedAtMs: 1_000,
      },
      lastActivityAtMs: 1_000,
      updatedAtMs: 1_000,
    });

    await recordConversationActivity({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state,
    });

    await expect(listActiveConversationIds({ state })).resolves.toContain(
      CONVERSATION_ID,
    );
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID, state }),
    ).resolves.toMatchObject({
      needsRun: true,
      execution: {
        status: "pending",
      },
    });
  });

  it("keeps failed execution metadata when pending mailbox work remains", async () => {
    const state = getStateAdapter();
    await state.connect();
    await appendInboundMessage({
      message: inboundMessage("m1"),
      nowMs: 1_000,
      state,
    });

    await recordConversationExecution({
      conversationId: CONVERSATION_ID,
      createdAtMs: 1_000,
      destination: SLACK_DESTINATION,
      execution: {
        status: "failed",
        updatedAtMs: 2_000,
      },
      lastActivityAtMs: 2_000,
      state,
      updatedAtMs: 2_000,
    });

    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID, state }),
    ).resolves.toMatchObject({
      needsRun: true,
      execution: {
        status: "failed",
      },
    });
  });

  it("rejects pending messages with a different conversation destination", async () => {
    const state = getStateAdapter();
    await state.connect();
    await state.set(CONVERSATION_WORK_STATE_KEY, {
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      createdAtMs: 1_000,
      destination: SLACK_DESTINATION,
      execution: {
        inboundMessageIds: ["m1"],
        pendingCount: 1,
        pendingMessages: [
          {
            ...inboundMessage("m1"),
            destination: OTHER_SLACK_DESTINATION,
          },
        ],
        status: "pending",
        updatedAtMs: 1_000,
      },
      lastActivityAtMs: 1_000,
      updatedAtMs: 1_000,
    });

    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID, state }),
    ).rejects.toThrow(`Conversation record is invalid for ${CONVERSATION_ID}`);
  });

  it("defers duplicate queue nudges while a conversation lease is active", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();
    let runs = 0;

    const first = processConversationWork(conversationQueueMessage(), {
      queue,
      run: async (context) => {
        runs += 1;
        await context.attempt.drain(async () => {});
        entered.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await entered.promise;

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async () => {
          runs += 1;
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "active" });
    expect(runs).toBe(1);
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        delayMs: CONVERSATION_WORK_DEFER_DELAY_MS,
      },
    ]);

    finish.resolve();
    await expect(first).resolves.toEqual({ status: "completed" });
  });

  it("wakes fresh inbound work after a consumed deferred nudge left a recent marker", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();

    const first = processConversationWork(conversationQueueMessage(), {
      nowMs: () => currentNowMs,
      queue,
      run: async (context) => {
        await context.attempt.drain(async () => {});
        entered.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await entered.promise;

    currentNowMs = 2_000;
    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => ({ status: "completed" }),
      }),
    ).resolves.toEqual({ status: "active" });

    currentNowMs = 3_000;
    finish.resolve();
    await expect(first).resolves.toEqual({ status: "completed" });

    currentNowMs = 4_000;
    await expect(
      processConversationWork(queue.takeMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => ({ status: "completed" }),
      }),
    ).resolves.toEqual({ status: "no_work" });

    queue.clearSentRecords();
    currentNowMs = 5_000;
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m2", {
          createdAtMs: 5_000,
          receivedAtMs: 5_000,
        }),
        nowMs: currentNowMs,
        queue,
      }),
    ).resolves.toMatchObject({ status: "appended", queueMessageId: "queue-1" });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m2",
      },
    ]);
  });

  it("rejects queue messages whose destination does not match persisted work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const run = vi.fn(async () => ({ status: "completed" as const }));
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(
        conversationQueueMessage({ destination: OTHER_SLACK_DESTINATION }),
        {
          queue,
          run,
        },
      ),
    ).rejects.toThrow("Conversation work queue destination changed");

    expect(run).not.toHaveBeenCalled();
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(work).toMatchObject({ destination: SLACK_DESTINATION });
    expect(work?.lease).toBeUndefined();
  });

  it("rejects continuation requests that change a conversation destination", async () => {
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
    });
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 2_000,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") {
      return;
    }

    await expect(
      requestConversationContinuation({
        conversationId: CONVERSATION_ID,
        destination: OTHER_SLACK_DESTINATION,
        leaseToken: lease.leaseToken,
        nowMs: 3_000,
      }),
    ).rejects.toThrow("Conversation destination changed");
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID }),
    ).resolves.toMatchObject({
      destination: SLACK_DESTINATION,
    });
  });

  it("requeues work requested while a lease is running", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          currentNowMs = 2_000;
          await requestConversationWork({
            conversationId: context.conversationId,
            destination: context.destination,
            nowMs: currentNowMs,
          });
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(0);
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:2000`,
      },
    ]);
  });

  it("does not send a second nudge when a continuation wake was already queued during the lease", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          currentNowMs = 2_000;
          await requestConversationWork({
            conversationId: context.conversationId,
            destination: context.destination,
            nowMs: currentNowMs,
          });
          await scheduleAgentContinue(
            {
              conversationId: context.conversationId,
              destination: context.destination,
              expectedVersion: 2,
              sessionId: "turn-1",
            },
            { queue, nowMs: currentNowMs },
          );
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state?.lastEnqueuedAtMs).toBe(2_000);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `agent-continue:${CONVERSATION_ID}:turn-1:2:2000`,
      },
    ]);
  });

  it("uses an existing conversation wake for pending mailbox and continuation work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          currentNowMs = 2_000;
          await requestConversationWork({
            conversationId: context.conversationId,
            destination: context.destination,
            nowMs: currentNowMs,
          });
          await scheduleAgentContinue(
            {
              conversationId: context.conversationId,
              destination: context.destination,
              expectedVersion: 2,
              sessionId: "turn-1",
            },
            { queue, nowMs: currentNowMs },
          );
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_100,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state?.messages.map((message) => message.inboundMessageId)).toEqual([
      "m2",
    ]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `agent-continue:${CONVERSATION_ID}:turn-1:2:2000`,
      },
    ]);
  });

  it("uses fresh queue idempotency keys for repeated worker requeues", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: currentNowMs,
    });

    async function runSlice(nowMs: number): Promise<void> {
      currentNowMs = nowMs;
      await expect(
        processConversationWork(conversationQueueMessage(), {
          nowMs: () => currentNowMs,
          queue,
          run: async (context) => {
            await requestConversationWork({
              conversationId: context.conversationId,
              destination: context.destination,
              nowMs: currentNowMs,
            });
            return { status: "completed" };
          },
        }),
      ).resolves.toEqual({ status: "pending_requeued" });
    }

    await runSlice(2_000);
    await runSlice(63_000);

    expect(queue.sentRecords().map((send) => send.idempotencyKey)).toEqual([
      `pending:${CONVERSATION_ID}:2000`,
      `pending:${CONVERSATION_ID}:63000`,
    ]);
  });

  it("acknowledges failed worker runs after one nudge instead of a queue retry", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: currentNowMs,
    });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => {
          currentNowMs = 2_000;
          throw new Error("runner failed");
        },
      }),
    ).resolves.toEqual({ status: "failed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state?.lastEnqueuedAtMs).toBe(2_000);
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `error:${CONVERSATION_ID}:2000`,
      },
    ]);
  });

  it("does not send a second error nudge when a continuation wake already exists", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          currentNowMs = 2_000;
          await scheduleAgentContinue(
            {
              conversationId: context.conversationId,
              destination: context.destination,
              expectedVersion: 2,
              sessionId: "turn-1",
            },
            { queue, nowMs: currentNowMs },
          );
          throw new Error("runner failed");
        },
      }),
    ).resolves.toEqual({ status: "failed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state?.lastEnqueuedAtMs).toBe(2_000);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `agent-continue:${CONVERSATION_ID}:turn-1:2:2000`,
      },
    ]);
  });

  it("dead-letters a message that exceeds the delivery attempt limit", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    // Deterministic pre-ack failure: the runner returns without durably
    // handling the attempted message, which requeued forever before
    // attempts were bounded.
    const runSlice = () =>
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => ({ status: "completed" }),
      });

    for (
      let attempt = 1;
      attempt < CONVERSATION_WORK_MAX_DELIVERY_ATTEMPTS;
      attempt += 1
    ) {
      currentNowMs = attempt * 1_000;
      await expect(runSlice()).resolves.toEqual({
        status: "pending_requeued",
      });
      const state = await getConversationWorkState({
        conversationId: CONVERSATION_ID,
      });
      expect(state?.messages).toEqual([
        expect.objectContaining({
          inboundMessageId: "m1",
          attemptCount: attempt,
        }),
      ]);
    }

    queue.clearSentRecords();
    currentNowMs = 9_000;
    await expect(runSlice()).resolves.toEqual({ status: "failed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.messages).toEqual([]);
    expect(state?.execution.inboundMessageIds).toEqual(["m1"]);
    expect(state?.execution.status).toBe("failed");
    expect(state?.needsRun).toBe(false);
    expect(state?.lease).toBeUndefined();
    expect(queue.sentRecords()).toEqual([]);
    await expect(listActiveConversationIds()).resolves.toEqual([]);

    // Source retries of the consumed message stay duplicates.
    await expect(
      appendInboundMessage({ message: inboundMessage("m1"), nowMs: 10_000 }),
    ).resolves.toEqual({ status: "duplicate" });
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID }),
    ).resolves.toMatchObject({ messages: [] });
  });

  it("acknowledges deliveries for conversation records that fail validation as rejected", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    await state.set(CONVERSATION_WORK_STATE_KEY, {
      schemaVersion: 1,
      conversationId: CONVERSATION_ID,
      createdAtMs: 1_000,
      destination: SLACK_DESTINATION,
      execution: { status: "bogus" },
      lastActivityAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    const run = vi.fn(async () => ({ status: "completed" as const }));

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run,
        state,
      }),
    ).rejects.toMatchObject({
      name: "ConversationQueueMessageRejectedError",
      reason: "invalid_record",
      conversationId: CONVERSATION_ID,
    });

    expect(run).not.toHaveBeenCalled();
    expect(queue.sendAttempts()).toEqual([]);
  });

  it("releases and requeues runnable work when the runner reports lost lease", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => {
          currentNowMs = 2_000;
          return { status: "lost_lease" };
        },
      }),
    ).resolves.toEqual({ status: "lost_lease" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(1);
    expect(state?.lastEnqueuedAtMs).toBe(2_000);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `lost_lease:${CONVERSATION_ID}:2000`,
      },
    ]);
  });

  it("drains pending messages and completes the leased conversation", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: InboundMessage[][] = [];

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          injected.push(await context.attempt.drain(async () => {}));
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual([
      [expect.objectContaining({ inboundMessageId: "m1" })],
    ]);
    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(false);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(0);
  });

  it("keeps unacknowledged drained messages pending for a later slice", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    await appendInboundMessage({
      message: inboundMessage("m2", {
        createdAtMs: 2_000,
        receivedAtMs: 2_100,
      }),
      nowMs: 2_100,
    });
    const injected: string[][] = [];

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          await context.attempt.drain(async (messages) => {
            injected.push(messages.map((message) => message.inboundMessageId));
            return messages
              .filter((message) => message.inboundMessageId === "m1")
              .map((message) => message.inboundMessageId);
          });
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    expect(injected).toEqual([["m1", "m2"]]);
    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.needsRun).toBe(true);
    expect(state?.messages.map((message) => message.inboundMessageId)).toEqual([
      "m2",
    ]);
  });

  it("rejects mailbox acknowledgements outside the pending set", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    let drainError: unknown;
    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          try {
            await context.attempt.drain(async () => ["different-message"]);
          } catch (error) {
            drainError = error;
            throw error;
          }
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "failed" });

    expect(String(drainError)).toContain(
      "Conversation mailbox acknowledgement is not pending for",
    );

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.messages.map((message) => message.inboundMessageId)).toEqual([
      "m1",
    ]);
  });

  it("does not block new mailbox appends while injection is in progress", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const observed = observeConversationMutationLock({
      conversationId: CONVERSATION_ID,
      state: getStateAdapter(),
    });
    await appendInboundMessage({
      message: inboundMessage("m1"),
      nowMs: 1_000,
      state: observed.state,
    });
    const injectionStarted = deferred<void>();
    const finishInjection = deferred<void>();

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        state: observed.state,
        run: async (context) => {
          const drain = context.attempt.drain(async () => {
            expect(observed.isHeld()).toBe(false);
            injectionStarted.resolve();
            await finishInjection.promise;
          });
          await injectionStarted.promise;

          const append = appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
            state: observed.state,
          });

          finishInjection.resolve();
          await drain;
          await append;
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: observed.state,
    });
    expect(state?.needsRun).toBe(true);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(1);
    expect(state?.messages.map((message) => message.inboundMessageId)).toEqual([
      "m2",
    ]);
    expect(state?.messages.map((message) => message.injectedAtMs)).toEqual([
      undefined,
    ]);
  });

  it("extends the lease with worker check-ins during long execution", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();

    const running = processConversationWork(conversationQueueMessage(), {
      checkInIntervalMs: 15_000,
      queue,
      run: async (context) => {
        await context.attempt.drain(async () => {});
        entered.resolve();
        await finish.promise;
        return { status: "completed" };
      },
    });
    await entered.promise;
    const before = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    const after = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });

    expect(before?.lease?.leaseExpiresAtMs).toBe(
      1_000 + CONVERSATION_WORK_LEASE_TTL_MS,
    );
    expect(after?.lease?.leaseExpiresAtMs).toBe(
      16_000 + CONVERSATION_WORK_LEASE_TTL_MS,
    );

    finish.resolve();
    await expect(running).resolves.toEqual({ status: "completed" });
  });

  it("reports lost lease after periodic check-in loses ownership", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<{
      shouldYield: () => boolean;
    }>();
    const finish = deferred<void>();

    const running = processConversationWork(conversationQueueMessage(), {
      checkInIntervalMs: 15_000,
      queue,
      run: async (context) => {
        await context.attempt.drain(async () => {});
        entered.resolve({
          shouldYield: context.shouldYield,
        });
        await finish.promise;
        return { status: context.shouldYield() ? "yielded" : "completed" };
      },
    });
    const runningContext = await entered.promise;
    const leased = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    const leaseToken = leased?.execution.lease?.token;
    expect(leaseToken).toBeDefined();

    await releaseConversationWork({
      conversationId: CONVERSATION_ID,
      leaseToken: leaseToken!,
      nowMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runningContext.shouldYield()).toBe(true);
    finish.resolve();
    await expect(running).resolves.toEqual({ status: "lost_lease" });
  });

  it("requeues an expired conversation lease from heartbeat", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    await expect(
      startConversationWork({ conversationId: CONVERSATION_ID, nowMs: 2_000 }),
    ).resolves.toMatchObject({ status: "acquired" });

    await expect(
      recoverConversationWork({
        nowMs: 2_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:lease:${CONVERSATION_ID}:92000`,
      },
    ]);
  });

  it("keeps an expired injected-message lease runnable for continuation recovery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 2_000,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") {
      return;
    }
    await ackMessages({
      conversationId: CONVERSATION_ID,
      inboundMessageIds: ["m1"],
      leaseToken: lease.leaseToken,
      nowMs: 3_000,
    });

    await expect(
      recoverConversationWork({
        nowMs: 2_000 + CONVERSATION_WORK_LEASE_TTL_MS,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 1, pendingCount: 0 });
    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async () => ({ status: "completed" }),
      }),
    ).resolves.toEqual({ status: "completed" });
  });

  it("requeues pending mailbox work with no recent queue marker", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    expect(queue.sentRecords()).toHaveLength(1);
  });

  it("uses fresh queue idempotency keys for repeated heartbeat recovery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    await expect(
      recoverConversationWork({
        nowMs: 122_001,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });

    expect(queue.sentRecords().map((send) => send.idempotencyKey)).toEqual([
      `heartbeat:pending:${CONVERSATION_ID}:62000`,
      `heartbeat:pending:${CONVERSATION_ID}:122001`,
    ]);
  });

  it("removes unreadable conversation records from the active index and repairs the rest", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const unreadableConversationId = "slack:C123:9999.0001";

    await requestConversationWork({
      conversationId: unreadableConversationId,
      destination: SLACK_DESTINATION,
      nowMs: 500,
      state,
    });
    await state.set(`junior:conversation:${unreadableConversationId}`, {
      schemaVersion: 1,
      conversationId: unreadableConversationId,
      createdAtMs: 500,
      destination: SLACK_DESTINATION,
      execution: { status: "bogus" },
      lastActivityAtMs: 500,
      updatedAtMs: 500,
    });
    await appendInboundMessage({
      message: inboundMessage("m1"),
      nowMs: 1_000,
      state,
    });

    await expect(
      recoverConversationWork({ nowMs: 62_000, queue, state }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });

    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    ]);
    const activeIds = await listActiveConversationIds({ state });
    expect(activeIds).not.toContain(unreadableConversationId);
    expect(activeIds).toContain(CONVERSATION_ID);
  });

  it("refuses a stale conversation write after the mutation lock is lost", async () => {
    const state = getStateAdapter();
    await state.connect();
    await appendInboundMessage({
      message: inboundMessage("m1"),
      nowMs: 1_000,
      state,
    });

    let stealLockOnNextRead = false;
    const proxied = new Proxy(state, {
      get(target, prop, receiver) {
        if (prop === "get") {
          return async (key: string) => {
            const value = await target.get(key);
            if (stealLockOnNextRead && key === CONVERSATION_WORK_STATE_KEY) {
              stealLockOnNextRead = false;
              await target.forceReleaseLock(
                `junior:conversation:mutation:${CONVERSATION_ID}`,
              );
            }
            return value;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter;

    stealLockOnNextRead = true;
    await expect(
      appendInboundMessage({
        message: inboundMessage("m2", {
          createdAtMs: 2_000,
          receivedAtMs: 2_100,
        }),
        nowMs: 2_000,
        state: proxied,
      }),
    ).rejects.toThrow("Conversation mutation lock was lost before write");

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages.map((message) => message.inboundMessageId)).toEqual([
      "m1",
    ]);
  });

  it("runs conversation work recovery from the core heartbeat", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await runHeartbeat({
      nowMs: 62_000,
      conversationWorkQueue: queue,
    });

    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}:62000`,
      },
    ]);
  });

  it("injects messages that arrive during active execution at a safe boundary", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[][] = [];

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          const first = await context.attempt.drain(async () => {});
          injected.push(first.map((message) => message.inboundMessageId));
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          const second = await context.attempt.drain(async () => {});
          injected.push(second.map((message) => message.inboundMessageId));
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual([["m1"], ["m2"]]);
  });

  it("clears the run marker after draining messages that arrived during active execution", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          await context.attempt.drain(async () => {});
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.needsRun).toBe(false);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(0);
  });

  it("requeues instead of completing when final mailbox work remains", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          currentNowMs = 2_100;
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: currentNowMs,
          });
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "pending_requeued" });
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:2100`,
      },
    ]);
  });

  it("yields cooperatively and leaves the conversation resumable", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.attempt.drain(async () => {});
          currentNowMs = 242_000;
          expect(context.shouldYield()).toBe(true);
          return { status: "yielded" };
        },
      }),
    ).resolves.toEqual({ status: "yielded" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `yield:${CONVERSATION_ID}:242000`,
      },
    ]);
  });

  it("keeps lease mutations token-bound", async () => {
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 2_000,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") {
      return;
    }

    await expect(
      checkInConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe(false);
    await expect(
      drainConversationMailbox({
        conversationId: CONVERSATION_ID,
        leaseToken: "wrong-token",
        handle: async () => {},
        nowMs: 3_000,
      }),
    ).rejects.toThrow("lease is not held");
    await expect(
      completeConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe("lost_lease");
    await expect(
      ackMessages({
        conversationId: CONVERSATION_ID,
        inboundMessageIds: ["m1"],
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe(false);
  });

  it("deduplicates accepted fake queue payloads by idempotency key", async () => {
    const queue = createConversationWorkQueueTestAdapter();

    await expect(
      queue.send(conversationQueueMessage(), { idempotencyKey: "m1" }),
    ).resolves.toEqual({ messageId: "queue-1" });
    await expect(
      queue.send(conversationQueueMessage(), { idempotencyKey: "m1" }),
    ).resolves.toEqual({ messageId: "queue-1" });

    expect(queue.sendAttempts()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
    ]);
    expect(queue.sentRecords()).toEqual([
      {
        conversationId: CONVERSATION_ID,
        destination: SLACK_DESTINATION,
        idempotencyKey: "m1",
      },
    ]);
    expect(queue.queuedMessages()).toEqual([conversationQueueMessage()]);
  });

  it("maps the generic queue port to Vercel Queue send options", async () => {
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    const sends: Array<{
      message: unknown;
      options: unknown;
      topic: string;
    }> = [];
    const queue = createVercelConversationWorkQueue({
      topic: "junior_test_work",
      client: {
        async send(topic, message, options) {
          sends.push({ topic, message, options });
          return { messageId: "msg_123" };
        },
      },
    });

    await expect(
      queue.send(conversationQueueMessage(), {
        delayMs: 15_001,
        idempotencyKey: "idem-1",
      }),
    ).resolves.toEqual({ messageId: "msg_123" });

    expect(sends).toEqual([
      {
        topic: "junior_test_work",
        message: expect.objectContaining({
          conversationId: CONVERSATION_ID,
          signature: expect.any(String),
          signatureVersion: "v1",
          signedAtMs: expect.any(Number),
        }),
        options: {
          delaySeconds: 16,
          idempotencyKey: "idem-1",
          retentionSeconds: 3_600,
        },
      },
    ]);
  });

  it("verifies signed Vercel Queue callback payloads", () => {
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    const signedAtMs = 12_345;
    const maxSkewMs = 60 * 60 * 1000;
    const signed = signConversationQueueMessage(
      conversationQueueMessage(),
      signedAtMs,
    );

    expect(verifySignedConversationQueueMessage(signed, signedAtMs)).toEqual({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
    expect(
      verifySignedConversationQueueMessage(
        {
          ...signed,
          conversationId: "slack:C123:forged",
        },
        signedAtMs,
      ),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage(
        {
          ...signed,
          signature: "deadbeef",
        },
        signedAtMs,
      ),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage(signed, signedAtMs + maxSkewMs + 1),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage(signed, signedAtMs - maxSkewMs - 1),
    ).toBeUndefined();
  });

  it("signs queue destinations by identity rather than object key order", () => {
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    const signedAtMs = 12_345;
    const signed = signConversationQueueMessage(
      {
        conversationId: CONVERSATION_ID,
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
      },
      signedAtMs,
    );

    expect(verifySignedConversationQueueMessage(signed, signedAtMs)).toEqual({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
  });

  it("keeps queue signatures valid across default visibility redelivery", () => {
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    const signedAtMs = 12_345;
    const signed = signConversationQueueMessage(
      conversationQueueMessage(),
      signedAtMs,
    );

    expect(
      verifySignedConversationQueueMessage(signed, signedAtMs + 330_000),
    ).toEqual({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
    });
  });

  it("processes Vercel Queue payloads through the leased worker", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[] = [];

    await expect(
      processConversationQueueMessage(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          const messages = await context.attempt.drain(async () => {});
          injected.push(...messages.map((message) => message.inboundMessageId));
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual(["m1"]);
  });

  it("rejects malformed Vercel Queue payloads", async () => {
    const queue = createConversationWorkQueueTestAdapter();

    await expect(
      processConversationQueueMessage(
        { wrong: CONVERSATION_ID },
        {
          queue,
          run: async () => ({ status: "completed" }),
        },
      ),
    ).rejects.toThrow("missing destination context");
  });
});
