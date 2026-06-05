import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  appendInboundMessage,
  checkInConversationWork,
  completeConversationWork,
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  markConversationMessagesInjected,
  releaseConversationWork,
  requestConversationContinuation,
  requestConversationWork,
  startConversationWork,
  type InboundMessageRecord,
} from "@/chat/task-execution/store";
import {
  CONVERSATION_WORK_DEFER_DELAY_MS,
  processConversationWork,
} from "@/chat/task-execution/worker";
import { describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_ID,
  OTHER_SLACK_DESTINATION,
  SLACK_DESTINATION,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  deferred,
  inboundMessage,
} from "../../fixtures/conversation-work";
import {
  mockTestClock,
  useMemoryStateAdapter,
  useRealTimersAfterEach,
} from "../../fixtures/vitest";

describe("conversation work leases", () => {
  useMemoryStateAdapter();
  useRealTimersAfterEach();

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
        await context.drainMailbox(async () => {});
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

  it("requeues work requested while a lease is running", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
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

  it("nudges failed worker runs before releasing runnable work", async () => {
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
    ).rejects.toThrow("runner failed");

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
    const injected: InboundMessageRecord[][] = [];

    await expect(
      processConversationWork(conversationQueueMessage(), {
        queue,
        run: async (context) => {
          injected.push(await context.drainMailbox(async () => {}));
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

  it("extends the lease with worker check-ins during long execution", async () => {
    mockTestClock(1_000);
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();

    const running = processConversationWork(conversationQueueMessage(), {
      checkInIntervalMs: 15_000,
      queue,
      run: async (context) => {
        await context.drainMailbox(async () => {});
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
    mockTestClock(1_000);
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<{
      leaseToken: string;
      shouldYield: () => boolean;
    }>();
    const finish = deferred<void>();

    const running = processConversationWork(conversationQueueMessage(), {
      checkInIntervalMs: 15_000,
      queue,
      run: async (context) => {
        await context.drainMailbox(async () => {});
        entered.resolve({
          leaseToken: context.leaseToken,
          shouldYield: context.shouldYield,
        });
        await finish.promise;
        return { status: context.shouldYield() ? "yielded" : "completed" };
      },
    });
    const runningContext = await entered.promise;

    await releaseConversationWork({
      conversationId: CONVERSATION_ID,
      leaseToken: runningContext.leaseToken,
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
    await markConversationMessagesInjected({
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

  it("yields cooperatively and leaves the conversation resumable", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
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
        inject: async () => {},
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
      markConversationMessagesInjected({
        conversationId: CONVERSATION_ID,
        inboundMessageIds: ["m1"],
        leaseToken: "wrong-token",
        nowMs: 3_000,
      }),
    ).resolves.toBe(false);
  });
});
