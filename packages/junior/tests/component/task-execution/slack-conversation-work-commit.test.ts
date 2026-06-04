import { CooperativeTurnYieldError } from "@/chat/runtime/turn";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  processNextQueuedSlackWork,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

describe("Slack conversation work input commits", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("keeps Slack mailbox records pending when input commit fails", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleNewMention: async () => {
            throw new Error("runtime failed before input commit");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).rejects.toThrow("runtime failed before input commit");

    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("requeues Slack mailbox records when the runtime returns without input commit", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up during resume`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    let handled = 0;
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => 3_000,
        queue,
        runtime: {
          handleNewMention: async () => {
            handled += 1;
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    expect(handled).toBe(1);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:3000`,
      }),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("reports lost lease when input commit loses the mailbox lease", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up during lease loss`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => currentNowMs,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            currentNowMs = 1_000 + CONVERSATION_WORK_LEASE_TTL_MS + 1;
            await recoverConversationWork({
              nowMs: currentNowMs,
              queue,
              state,
            });
            await hooks?.onInputCommitted?.();
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "lost_lease" });

    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `heartbeat:lease:${CONVERSATION_ID}:${currentNowMs}`,
      }),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(1);
    expect(work?.messages[0]?.injectedAtMs).toBeUndefined();
  });

  it("completes Slack mailbox work when the handler finishes after the soft deadline", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => currentNowMs,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            currentNowMs = 242_000;
            await hooks?.onInputCommitted?.();
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(queue.sentRecords()).toEqual([]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.needsRun).toBe(false);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("yields Slack mailbox work after a persisted safe boundary", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let currentNowMs = 1_000;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    queue.clearSentRecords();

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        nowMs: () => currentNowMs,
        queue,
        runtime: {
          handleNewMention: async (_thread, _message, hooks) => {
            await hooks?.onInputCommitted?.();
            currentNowMs = 242_000;
            throw new CooperativeTurnYieldError();
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "yielded" });

    expect(queue.sentRecords()).toMatchObject([
      {
        conversationId: CONVERSATION_ID,
        idempotencyKey: `yield:${CONVERSATION_ID}:242000`,
      },
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.lease).toBeUndefined();
    expect(work?.needsRun).toBe(true);
    expect(work?.messages.map((message) => message.injectedAtMs)).toEqual([
      expect.any(Number),
    ]);
  });
});
