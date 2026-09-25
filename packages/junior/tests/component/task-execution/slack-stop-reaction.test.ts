import { afterEach, expect, it } from "vitest";
import type { Lock, StateAdapter } from "chat";
import { createSlackRuntime } from "@/chat/app/factory";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  clearSlackPendingReactions,
  createSlackConversationWorker,
} from "@/chat/task-execution/slack-work";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { processConversationQueueMessage } from "@/chat/task-execution/vercel-callback";
import { neverRunAgentRunner } from "../../fixtures/agent-runner";
import {
  CONVERSATION_ID,
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  createNoopSlackWebhookRuntime,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { readProxyProperty } from "../../fixtures/proxy-property";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";

// This race needs control of the state boundary, so it belongs in component
// coverage. Ingress, the worker, and Slack runtime still run unchanged.
afterEach(async () => {
  await disconnectStateAdapter();
});

it("clears a queued receipt when a worker discards input before stop requests work", async () => {
  const state = getStateAdapter();
  const queue = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  const runtime = createSlackRuntime({
    getSlackAdapter: () => adapter,
    services: { agentRunner: neverRunAgentRunner() },
  });
  let drainAfterWatermark = false;
  let drained = false;
  const ingressState = new Proxy(state, {
    get(target, prop) {
      if (prop === "releaseLock") {
        return async (lock: Lock) => {
          await target.releaseLock(lock);
          if (
            drainAfterWatermark &&
            lock.threadId === `slack:thread-stop-lock:${CONVERSATION_ID}`
          ) {
            drainAfterWatermark = false;
            await processConversationQueueMessage(queue.takeMessage(), {
              queue,
              state,
              run: createSlackConversationWorker({
                getSlackAdapter: () => adapter,
                runNextPausedTurn: async () => false,
                runtime,
                state,
              }),
            });
            const work = await getConversationWorkState({
              conversationId: CONVERSATION_ID,
              state,
            });
            expect(work?.execution.pendingMessages).toEqual([]);
            expect(work?.execution.runId).toBeUndefined();
            drained = true;
          }
        };
      }
      const value = readProxyProperty(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const services = {
    getSlackAdapter: () => adapter,
    queue,
    runtime,
    state: ingressState as StateAdapter,
  };
  await handleSlackWebhookAndFlush({
    request: slackWebhookRequest(
      slackEnvelope({ text: "<@U0BOT> queued task" }),
    ),
    services,
  });
  expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
  drainAfterWatermark = true;
  const response = await handleSlackWebhookAndFlush({
    request: slackWebhookRequest(
      slackEnvelope({
        text: "<@U0BOT> stop",
        ts: "1712345.0002",
        threadTs: "1712345.0001",
      }),
    ),
    services,
  });
  expect(response.status).toBe(200);
  expect(drained).toBe(true);
  expect(slackApiOutbox.reactionRemovals().map((call) => call.params)).toEqual([
    expect.objectContaining({
      channel: "C123",
      timestamp: "1712345.0001",
      name: "eyes",
    }),
  ]);
  expect(await state.isSubscribed(CONVERSATION_ID)).toBe(false);
  expect(slackApiOutbox.messages()).toHaveLength(1);
});

it("continues receipt cleanup after an adapter setup failure", async () => {
  const state = getStateAdapter();
  const queue = createConversationWorkQueueTestAdapter();
  const adapter = createSlackAdapterFixture();
  const services = {
    getSlackAdapter: () => adapter,
    queue,
    state,
    runtime: createNoopSlackWebhookRuntime(),
  };
  for (const ts of ["1712345.0001", "1712345.0002"]) {
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: "<@U0BOT> queued task",
          ts,
          threadTs: "1712345.0001",
        }),
      ),
      services,
    });
  }
  const work = await getConversationWorkState({
    conversationId: CONVERSATION_ID,
    state,
  });
  expect(work?.execution.pendingMessages).toHaveLength(2);
  let attempts = 0;
  await expect(
    clearSlackPendingReactions({
      getSlackAdapter: () => {
        if (++attempts === 1) throw new Error("Slack adapter unavailable");
        return adapter;
      },
      messages: work!.execution.pendingMessages,
      state,
    }),
  ).resolves.toBeUndefined();
  expect(slackApiOutbox.reactionRemovals().map((call) => call.params)).toEqual([
    expect.objectContaining({
      channel: "C123",
      timestamp: "1712345.0002",
      name: "eyes",
    }),
  ]);
});
