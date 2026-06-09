import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { ConversationQueueMessageRejectedError } from "@/chat/task-execution/queue";
import {
  appendAndEnqueueInboundMessage,
  appendInboundMessage,
  checkInConversationWork,
  completeConversationWork,
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  drainConversationMailbox,
  getConversationWorkState,
  listConversationWorkIds,
  markConversationMessagesInjected,
  requestConversationContinuation,
  requestConversationWork,
  releaseConversationWork,
  startConversationWork,
  type InboundMessageRecord,
} from "@/chat/task-execution/store";
import {
  CONVERSATION_WORK_DEFER_DELAY_MS,
  processConversationWork,
} from "@/chat/task-execution/worker";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import {
  CONVERSATION_WORK_QUEUE_RETENTION_SECONDS,
  createVercelConversationWorkQueue,
} from "@/chat/task-execution/vercel-queue";
import {
  signConversationQueueMessage,
  verifySignedConversationQueueMessage,
} from "@/chat/task-execution/queue-signing";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  CONVERSATION_ID,
  SLACK_DESTINATION,
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
const CONVERSATION_WORK_STATE_KEY = `junior:conversation-work:state:${CONVERSATION_ID}`;

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
    expect(state?.messages).toHaveLength(1);
    expect(state ? countPendingConversationMessages(state) : 0).toBe(1);
    expect(queue.sendAttempts()).toHaveLength(1);
    expect(queue.sentRecords()).toHaveLength(1);
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
      messages: [legacyMessage],
      needsRun: true,
      updatedAtMs: 1_000,
    };
    await state.set(CONVERSATION_WORK_STATE_KEY, legacyWork);

    await expect(
      appendInboundMessage({
        message: inboundMessage("m2"),
        nowMs: 2_000,
        state,
      }),
    ).rejects.toThrow("Conversation work state is invalid");

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

  it("keeps runnable conversation ids when the recovery index overflows", async () => {
    const state = getStateAdapter();
    await state.connect();
    const activeConversationId = "conversation-active";
    const newConversationId = "conversation-new";
    await requestConversationWork({
      conversationId: activeConversationId,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state,
    });
    await state.set(
      "junior:conversation-work:index",
      [
        activeConversationId,
        ...Array.from({ length: 9_999 }, (_, index) => `stale-${index}`),
      ],
      60_000,
    );

    await requestConversationWork({
      conversationId: newConversationId,
      destination: SLACK_DESTINATION,
      nowMs: 2_000,
      state,
    });

    const ids = await listConversationWorkIds({ state });
    expect(ids).toContain(activeConversationId);
    expect(ids).toContain(newConversationId);
    expect(ids).not.toContain("stale-0");
    expect(ids).toHaveLength(10_000);
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

  it("rejects queue messages whose destination does not match persisted work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const run = vi.fn(async () => ({ status: "completed" as const }));
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    let error: unknown;
    await processConversationWork(
      conversationQueueMessage({ destination: OTHER_SLACK_DESTINATION }),
      {
        queue,
        run,
      },
    ).catch((caught: unknown) => {
      error = caught;
    });
    expect(error).toBeInstanceOf(ConversationQueueMessageRejectedError);
    expect(error).toMatchObject({
      conversationId: CONVERSATION_ID,
      reason: "destination_mismatch",
    });

    expect(run).not.toHaveBeenCalled();
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID }),
    ).resolves.toMatchObject({
      destination: SLACK_DESTINATION,
      lease: undefined,
    });
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
    ).rejects.toThrow("Conversation work destination changed");
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

  it("nudges failed worker runs before releasing runnable work without rethrowing", async () => {
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
    ).resolves.toEqual({ status: "pending_requeued" });

    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(true);
    expect(state?.consecutiveFailureCount).toBe(1);
    expect(state?.lastFailureAtMs).toBe(2_000);
    expect(state?.lastEnqueuedAtMs).toBe(2_000);
    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `error:${CONVERSATION_ID}:2000`,
      },
    ]);
  });

  it("rethrows failed worker runs when own requeue nudge also fails", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
    });

    let runs = 0;
    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => 2_000,
        queue,
        run: async () => {
          runs += 1;
          queue.rejectSends();
          throw new Error("runner failed");
        },
      }),
    ).rejects.toThrow("runner failed");
    expect(runs).toBe(1);
    expect(queue.sentRecords()).toHaveLength(0);
  });

  it("abandons poison conversations after repeated failures and stops requeueing", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: currentNowMs,
    });

    for (let attempt = 1; attempt < 5; attempt += 1) {
      currentNowMs += 1_000;
      await expect(
        processConversationWork(conversationQueueMessage(), {
          nowMs: () => currentNowMs,
          queue,
          run: async () => {
            throw new Error("deterministic poison failure");
          },
        }),
      ).resolves.toEqual({ status: "pending_requeued" });
    }

    currentNowMs += 1_000;
    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => {
          throw new Error("deterministic poison failure");
        },
      }),
    ).resolves.toEqual({ status: "abandoned" });

    expect(queue.sentRecords()).toHaveLength(4);
    const state = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(state?.lease).toBeUndefined();
    expect(state?.needsRun).toBe(false);
    expect(state?.consecutiveFailureCount).toBe(5);
    expect(state?.terminallyFailedAtMs).toBe(currentNowMs);

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs + 1_000,
        queue,
        run: async () => {
          throw new Error("should not run");
        },
      }),
    ).resolves.toEqual({ status: "no_work" });
    expect(queue.sentRecords()).toHaveLength(4);
  });

  it("clears terminal failure state when a new inbound message arrives", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: currentNowMs,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      currentNowMs += 1_000;
      await processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => {
          throw new Error("deterministic poison failure");
        },
      });
    }
    const failed = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(failed?.terminallyFailedAtMs).toBeDefined();
    expect(failed?.consecutiveFailureCount).toBe(5);

    await appendInboundMessage({
      message: inboundMessage("m-after-failure", {
        createdAtMs: currentNowMs + 100,
        receivedAtMs: currentNowMs + 100,
      }),
      nowMs: currentNowMs + 100,
    });
    const fresh = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(fresh?.terminallyFailedAtMs).toBeUndefined();
    expect(fresh?.consecutiveFailureCount).toBe(0);
    expect(fresh?.needsRun).toBe(true);
  });

  it("resets the failure counter after a successful drain or completion", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
    });
    await processConversationWork(conversationQueueMessage(), {
      nowMs: () => 2_000,
      queue,
      run: async () => {
        throw new Error("transient");
      },
    });
    const afterFailure = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(afterFailure?.consecutiveFailureCount).toBe(1);

    await appendInboundMessage({
      message: inboundMessage("m-success", {
        createdAtMs: 3_000,
        receivedAtMs: 3_000,
      }),
      nowMs: 3_000,
    });
    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => 4_000,
        queue,
        run: async (context) => {
          await context.drainMailbox(async () => {});
          return { status: "completed" };
        },
      }),
    ).resolves.toEqual({ status: "completed" });

    const afterSuccess = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(afterSuccess?.consecutiveFailureCount).toBe(0);
    expect(afterSuccess?.lastFailureAtMs).toBeUndefined();
  });

  it("absorbs pre-lease mutation lock failures so vercel will not redeliver", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const baseState = getStateAdapter();
    await baseState.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state: baseState,
    });

    const mutationLockKey = `junior:conversation-work:mutation:${CONVERSATION_ID}`;
    const throwOnMutationLock = new Proxy(baseState, {
      get(target, prop, receiver) {
        if (prop === "acquireLock") {
          return async (key: string, ttlMs: number) => {
            if (key === mutationLockKey) {
              throw new Error(
                "Could not acquire conversation work mutation lock for test",
              );
            }
            return target.acquireLock(key, ttlMs);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof baseState;

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => 2_000,
        queue,
        run: async () => ({ status: "completed" }),
        state: throwOnMutationLock,
      }),
    ).resolves.toEqual({ status: "no_work" });
  });

  it("rethrows when failure recording fails so platform redelivery bounds the retry", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const baseState = getStateAdapter();
    await baseState.connect();
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: 1_000,
      state: baseState,
    });

    const mutationLockKey = `junior:conversation-work:mutation:${CONVERSATION_ID}`;
    let mutationLockCalls = 0;
    const failRecordMutationLock = new Proxy(baseState, {
      get(target, prop, receiver) {
        if (prop === "acquireLock") {
          return async (key: string, ttlMs: number) => {
            if (key === mutationLockKey) {
              mutationLockCalls += 1;
              if (mutationLockCalls >= 2) {
                throw new Error(
                  "Could not acquire conversation work mutation lock for test",
                );
              }
            }
            return target.acquireLock(key, ttlMs);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as typeof baseState;

    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => 2_000,
        queue,
        run: async () => {
          throw new Error("runner failed");
        },
        state: failRecordMutationLock,
      }),
    ).rejects.toThrow("runner failed");
    expect(queue.sentRecords()).toHaveLength(0);
  });

  it("does not resurrect terminally failed conversations via requestConversationWork", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: currentNowMs,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      currentNowMs += 1_000;
      await processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs,
        queue,
        run: async () => {
          throw new Error("deterministic poison failure");
        },
      });
    }
    const terminal = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(terminal?.terminallyFailedAtMs).toBeDefined();

    currentNowMs += 1_000;
    await requestConversationWork({
      conversationId: CONVERSATION_ID,
      destination: SLACK_DESTINATION,
      nowMs: currentNowMs,
    });

    const sentBefore = queue.sentRecords().length;
    await expect(
      processConversationWork(conversationQueueMessage(), {
        nowMs: () => currentNowMs + 1_000,
        queue,
        run: async () => {
          throw new Error("should not run after terminal failure");
        },
      }),
    ).resolves.toEqual({ status: "no_work" });
    expect(queue.sentRecords()).toHaveLength(sentBefore);
    const stillTerminal = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
    });
    expect(stillTerminal?.terminallyFailedAtMs).toBeDefined();
    expect(stillTerminal?.lease).toBeUndefined();
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
          const drain = context.drainMailbox(async () => {
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
      "m1",
      "m2",
    ]);
    expect(state?.messages.map((message) => message.injectedAtMs)).toEqual([
      expect.any(Number),
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
    vi.useFakeTimers({ now: 1_000 });
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
    const queue = createConversationWorkQueueTestAdapter();
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
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
    const queue = createConversationWorkQueueTestAdapter();
    let currentNowMs = 1_000;
    await appendInboundMessage({ message: inboundMessage("m1"), nowMs: 1_000 });

    await expect(
      processConversationWork(conversationQueueMessage(), {
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
          retentionSeconds: CONVERSATION_WORK_QUEUE_RETENTION_SECONDS,
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
          const messages = await context.drainMailbox(async () => {});
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
