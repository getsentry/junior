import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  appendInboundMessage,
  checkInConversationWork,
  completeConversationWork,
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  markConversationMessagesInjected,
  requestConversationWork,
  startConversationWork,
  type InboundMessageRecord,
} from "@/chat/task-execution/store";
import {
  CONVERSATION_WORK_DEFER_DELAY_MS,
  processConversationWork,
} from "@/chat/task-execution/worker";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { createVercelConversationWorkQueue } from "@/chat/task-execution/vercel-queue";
import {
  signConversationQueueMessage,
  verifySignedConversationQueueMessage,
} from "@/chat/task-execution/queue-signing";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ID,
  createFakeQueue,
  deferred,
  delayIndexLockOnce,
  delayMutationLockUntil,
  inboundMessage,
} from "../../fixtures/conversation-work";

describe("conversation work execution", () => {
  const originalJuniorSecret = process.env.JUNIOR_SECRET;

  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    if (originalJuniorSecret === undefined) {
      delete process.env.JUNIOR_SECRET;
    } else {
      process.env.JUNIOR_SECRET = originalJuniorSecret;
    }
    vi.useRealTimers();
  });

  it("stores inbound mailbox messages idempotently", async () => {
    const queue = createFakeQueue();
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
      queueMessageId: "queue-2",
    });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.messages).toHaveLength(1);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(1);
    expect(queue.sent).toHaveLength(2);
  });

  it("retries transient conversation work index lock contention", async () => {
    const queue = createFakeQueue();
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
    expect(queue.sent).toHaveLength(1);
  });

  it("waits through same-conversation mutation lock contention", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const queue = createFakeQueue();
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
    expect(queue.sent).toHaveLength(1);
  });

  it("repairs pending mailbox work when the initial queue send fails", async () => {
    const queue = createFakeQueue();
    queue.fail = true;
    await expect(
      appendAndEnqueueInboundMessage({
        message: inboundMessage("m1"),
        nowMs: 2_000,
        queue,
      }),
    ).rejects.toThrow("queue unavailable");

    queue.fail = false;
    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    expect(queue.sent).toEqual([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}:62000`,
      },
    ]);
  });

  it("defers duplicate queue nudges while a conversation lease is active", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();
    let runs = 0;

    const first = processConversationWork(CONVERSATION_ID, {
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
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async () => {
          runs += 1;
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "active" });
    expect(runs).toBe(1);
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        delayMs: CONVERSATION_WORK_DEFER_DELAY_MS,
      },
    ]);

    finish.resolve();
    await expect(first).resolves.toEqual({ status: "completed" });
  });

  it("requeues work requested while a lease is running", async () => {
    const queue = createFakeQueue();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          currentNowMs = 2_000;
          await requestConversationWork({
            conversationId: context.conversationId,
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
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:2000`,
      },
    ]);
  });

  it("uses fresh queue idempotency keys for repeated worker requeues", async () => {
    const queue = createFakeQueue();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: currentNowMs,
    });

    async function runSlice(nowMs: number): Promise<void> {
      currentNowMs = nowMs;
      await expect(
        processConversationWork(CONVERSATION_ID, {
          nowMs: () => currentNowMs,
          queue,
          run: async (context) => {
            await requestConversationWork({
              conversationId: context.conversationId,
              nowMs: currentNowMs,
            });
            return { status: "completed" };
          },
        }),
      ).resolves.toEqual({ status: "pending_requeued" });
    }

    await runSlice(2_000);
    await runSlice(63_000);

    expect(queue.sent.map((send) => send.idempotencyKey)).toEqual([
      `pending:${CONVERSATION_ID}:2000`,
      `pending:${CONVERSATION_ID}:63000`,
    ]);
  });

  it("nudges failed worker runs before releasing runnable work", async () => {
    const queue = createFakeQueue();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: currentNowMs,
    });

    await expect(
      processConversationWork(CONVERSATION_ID, {
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
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `error:${CONVERSATION_ID}:2000`,
      },
    ]);
  });

  it("drains pending messages and completes the leased conversation", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: InboundMessageRecord[][] = [];

    await expect(
      processConversationWork(CONVERSATION_ID, {
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
    vi.useFakeTimers({ now: 1_000 });
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const entered = deferred<void>();
    const finish = deferred<void>();

    const running = processConversationWork(CONVERSATION_ID, {
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

  it("requeues an expired conversation lease from heartbeat", async () => {
    const queue = createFakeQueue();
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
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:lease:${CONVERSATION_ID}:92000`,
      },
    ]);
  });

  it("keeps an expired injected-message lease runnable for continuation recovery", async () => {
    const queue = createFakeQueue();
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
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async () => ({ status: "completed" }),
      }),
    ).resolves.toEqual({ status: "completed" });
  });

  it("requeues pending mailbox work with no recent queue marker", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      recoverConversationWork({
        nowMs: 62_000,
        queue,
      }),
    ).resolves.toEqual({ expiredLeaseCount: 0, pendingCount: 1 });
    expect(queue.sent).toHaveLength(1);
  });

  it("uses fresh queue idempotency keys for repeated heartbeat recovery", async () => {
    const queue = createFakeQueue();
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

    expect(queue.sent.map((send) => send.idempotencyKey)).toEqual([
      `heartbeat:pending:${CONVERSATION_ID}:62000`,
      `heartbeat:pending:${CONVERSATION_ID}:122001`,
    ]);
  });

  it("runs conversation work recovery from the core heartbeat", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await runHeartbeat({
      nowMs: 62_000,
      conversationWorkQueue: queue,
    });

    expect(queue.sent).toEqual([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}:62000`,
      },
    ]);
  });

  it("injects messages that arrive during active execution at a safe boundary", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[][] = [];

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          const first = await context.drainMailbox(async () => {});
          injected.push(first.map((message) => message.inboundMessageId));
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          const second = await context.drainMailbox(async () => {});
          injected.push(second.map((message) => message.inboundMessageId));
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual([["m1"], ["m2"]]);
  });

  it("clears the run marker after draining messages that arrived during active execution", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          await appendInboundMessage({
            message: inboundMessage("m2", {
              createdAtMs: 2_000,
              receivedAtMs: 2_100,
            }),
            nowMs: 2_100,
          });
          await context.drainMailbox(async () => {});
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
    const queue = createFakeQueue();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
        nowMs: () => currentNowMs,
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
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
    expect(queue.sent).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:2100`,
      },
    ]);
  });

  it("yields cooperatively and leaves the conversation resumable", async () => {
    const queue = createFakeQueue();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(CONVERSATION_ID, {
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
    expect(queue.sent).toMatchObject([
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
      queue.send(
        { conversationId: CONVERSATION_ID },
        { delayMs: 15_001, idempotencyKey: "idem-1" },
      ),
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
          retentionSeconds: undefined,
        },
      },
    ]);
  });

  it("verifies signed Vercel Queue callback payloads", () => {
    process.env.JUNIOR_SECRET = "conversation-work-secret";
    const signed = signConversationQueueMessage(
      { conversationId: CONVERSATION_ID },
      12_345,
    );

    expect(verifySignedConversationQueueMessage(signed)).toEqual({
      conversationId: CONVERSATION_ID,
    });
    expect(
      verifySignedConversationQueueMessage({
        ...signed,
        conversationId: "slack:C123:forged",
      }),
    ).toBeUndefined();
    expect(
      verifySignedConversationQueueMessage({
        ...signed,
        signature: "deadbeef",
      }),
    ).toBeUndefined();
  });

  it("processes Vercel Queue payloads through the leased worker", async () => {
    const queue = createFakeQueue();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });
    const injected: string[] = [];

    await expect(
      processConversationQueueMessage(
        { conversationId: CONVERSATION_ID },
        {
          queue,
          run: async (context) => {
            const messages = await context.drainMailbox(async () => {});
            injected.push(
              ...messages.map((message) => message.inboundMessageId),
            );
            return { status: "completed" };
          },
        },
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(injected).toEqual(["m1"]);
  });

  it("rejects malformed Vercel Queue payloads", async () => {
    const queue = createFakeQueue();

    await expect(
      processConversationQueueMessage(
        { wrong: CONVERSATION_ID },
        {
          queue,
          run: async () => ({ status: "completed" }),
        },
      ),
    ).rejects.toThrow("missing conversationId");
  });
});
