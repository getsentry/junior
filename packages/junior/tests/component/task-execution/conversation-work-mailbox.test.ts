import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  appendAndEnqueueInboundMessage,
  appendInboundMessage,
  countPendingConversationMessages,
  getConversationWorkState,
  listConversationWorkIds,
  requestConversationWork,
} from "@/chat/task-execution/store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  delayIndexLockOnce,
  delayMutationLockUntil,
  inboundMessage,
} from "../../fixtures/conversation-work";

const CONVERSATION_WORK_STATE_KEY = `junior:conversation-work:state:${CONVERSATION_ID}`;

describe("conversation work mailbox", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
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
      nowMs: 2_000,
      state,
    });

    const ids = await listConversationWorkIds({ state });
    expect(ids).toContain(activeConversationId);
    expect(ids).toContain(newConversationId);
    expect(ids).not.toContain("stale-0");
    expect(ids).toHaveLength(10_000);
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
        idempotencyKey: `heartbeat:pending:${CONVERSATION_ID}:62000`,
      },
    ]);
  });
});
