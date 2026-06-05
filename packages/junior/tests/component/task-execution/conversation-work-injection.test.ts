import { getStateAdapter } from "@/chat/state/adapter";
import {
  appendInboundMessage,
  countPendingConversationMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { processConversationWork } from "@/chat/task-execution/worker";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_ID,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  deferred,
  inboundMessage,
  observeConversationMutationLock,
} from "../../fixtures/conversation-work";
import { useMemoryStateAdapter } from "../../fixtures/vitest";

describe("conversation work mailbox injection", () => {
  useMemoryStateAdapter();

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
});
