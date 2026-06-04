import type { createSlackConversationWorker } from "@/chat/task-execution/slack-work";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { recoverConversationWork } from "@/chat/task-execution/heartbeat";
import {
  CONVERSATION_WORK_LEASE_TTL_MS,
  countPendingConversationMessages,
  getConversationWorkState,
  markConversationMessagesInjected,
  startConversationWork,
} from "@/chat/task-execution/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("Slack conversation work steering", () => {
  beforeEach(async () => {
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it("drains Slack messages that arrive during an active turn into steering", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
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

    const injected: string[][] = [];
    const drained: string[][] = [];
    const runtime: SlackWorkerOptions["runtime"] = {
      handleNewMention: async (_thread, _message, hooks) => {
        await hooks?.onInputCommitted?.();
        await handleSlackWebhookAndFlush({
          request: slackWebhookRequest(
            slackEnvelope({
              text: `<@${SLACK_BOT_USER_ID}> steer this`,
              ts: "1712345.0002",
              threadTs: "1712345.0001",
            }),
          ),
          services: ingressServices,
        });
        const messages =
          (await hooks?.drainSteeringMessages?.(async (steering) => {
            injected.push(steering.map((message) => message.id));
          })) ?? [];
        drained.push(messages.map((message) => message.id));
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

    expect(injected).toEqual([["1712345.0002"]]);
    expect(drained).toEqual([["1712345.0002"]]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.messages.map((message) => message.injectedAtMs)).toEqual([
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(work ? countPendingConversationMessages(work) : 0).toBe(0);
    await expectRemainingQueuedSlackWorkIsNoop({
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime,
      state,
    });
  });

  it("does not replay injected Slack mailbox records after lease recovery", async () => {
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
    const lease = await startConversationWork({
      conversationId: CONVERSATION_ID,
      nowMs: 2_000,
      state,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") {
      return;
    }
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    const inboundMessageIds =
      work?.messages.map((message) => message.inboundMessageId) ?? [];
    await markConversationMessagesInjected({
      conversationId: CONVERSATION_ID,
      inboundMessageIds,
      leaseToken: lease.leaseToken,
      nowMs: 3_000,
      state,
    });
    await recoverConversationWork({
      nowMs: 2_000 + CONVERSATION_WORK_LEASE_TTL_MS,
      queue,
      state,
    });

    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleNewMention: async () => {
            throw new Error("injected messages should not replay");
          },
          handleSubscribedMessage: async () => {
            throw new Error("injected messages should not replay");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    const recovered = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(recovered?.needsRun).toBe(false);
    expect(recovered ? countPendingConversationMessages(recovered) : 0).toBe(0);
  });
});
