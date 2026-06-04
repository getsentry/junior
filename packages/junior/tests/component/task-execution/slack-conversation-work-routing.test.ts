import type { Message, Thread } from "chat";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  countPendingConversationMessages,
  getConversationWorkState,
} from "@/chat/task-execution/store";
import type { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { getMessageActorIdentity } from "@/chat/services/message-actor-identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  expectRemainingQueuedSlackWorkIsNoop,
  handleSlackWebhookAndFlush,
  processNextQueuedSlackWork,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

type SlackWorkerOptions = Parameters<typeof createSlackConversationWorker>[0];

describe("Slack conversation work routing", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("runs queued Slack mailbox work through the Slack runtime", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const calls: Array<{
      message: Message;
      skipped: Message[];
      thread: Thread;
    }> = [];

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
          ts: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> second`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (thread, message, hooks) => {
        await hooks?.onInputCommitted?.();
        calls.push({
          thread,
          message,
          skipped: hooks?.messageContext?.skipped ?? [],
        });
      },
      handleSubscribedMessage: async () => {
        throw new Error("unexpected subscribed route");
      },
    };
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.thread.id).toBe(CONVERSATION_ID);
    expect(calls[0]?.message.id).toBe("1712345.0002");
    expect(calls[0]?.message.text).toContain("second");
    expect(calls[0]?.skipped.map((message) => message.id)).toEqual([
      "1712345.0001",
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("binds resolved Slack actor identity before runtime handling", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    let capturedMessage: Message | undefined;

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> identify me`,
          ts: "1712345.0003",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, message, hooks) => {
        capturedMessage = message;
        await hooks.onInputCommitted?.();
      },
      handleSubscribedMessage: async () => {
        throw new Error("unexpected subscribed route");
      },
    };

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        lookupSlackUser: async () => ({
          email: "david@example.com",
          fullName: "David Cramer",
          userName: "dcramer",
        }),
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(capturedMessage?.author).toMatchObject({
      userId: "U123",
      userName: "dcramer",
      fullName: "David Cramer",
    });
    expect(getMessageActorIdentity(capturedMessage!)).toEqual({
      email: "david@example.com",
      fullName: "David Cramer",
      userId: "U123",
      userName: "dcramer",
    });
  });

  it("keeps restored thread context aligned with promoted mention routing", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const calls: Array<{
      message: Message;
      skipped: Message[];
      thread: Thread;
    }> = [];
    const subscribedValues: boolean[] = [];
    const ingressServices = {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> first`,
          ts: "1712345.0001",
        }),
      ),
      services: ingressServices,
    });
    await state.subscribe(CONVERSATION_ID);
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: "message",
          text: "follow-up without an explicit mention",
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: ingressServices,
    });
    const workBeforeProcessing = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(
      workBeforeProcessing?.messages.map((record) => record.input.metadata),
    ).toEqual([
      expect.objectContaining({ route: "mention" }),
      expect.objectContaining({ route: "subscribed" }),
    ]);
    await state.unsubscribe(CONVERSATION_ID);

    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (thread, message, hooks) => {
        await hooks?.onInputCommitted?.();
        subscribedValues.push(await thread.isSubscribed());
        calls.push({
          thread,
          message,
          skipped: hooks?.messageContext?.skipped ?? [],
        });
      },
      handleSubscribedMessage: async () => {
        throw new Error("mixed mention batches should promote to mention");
      },
    };
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime,
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message.id).toBe("1712345.0002");
    expect(calls[0]?.skipped.map((message) => message.id)).toEqual([
      "1712345.0001",
    ]);
    expect(subscribedValues).toEqual([false]);
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("processes pending Slack follow-ups when no continuation starts", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const resumeAwaitingContinuation = vi.fn(async () => false);

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    const calls: string[] = [];
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        resumeAwaitingContinuation,
        runtime: {
          handleNewMention: async (_thread, message, hooks) => {
            await hooks?.onInputCommitted?.();
            calls.push(message.text);
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(resumeAwaitingContinuation).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(calls).toEqual([expect.stringContaining("follow-up")]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
  });

  it("resumes awaiting continuations before routing pending Slack follow-ups", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const resumeAwaitingContinuation = vi.fn(async () => true);

    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> follow-up`,
          ts: "1712345.0002",
          threadTs: "1712345.0001",
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
        nowMs: () => 3_500,
        queue,
        resumeAwaitingContinuation,
        runtime: {
          handleNewMention: async () => {
            throw new Error("pending follow-up should wait for resume");
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "pending_requeued" });

    expect(resumeAwaitingContinuation).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        idempotencyKey: `pending:${CONVERSATION_ID}:3500`,
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
});
