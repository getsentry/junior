// Ingress rules for Slack messages that reach a thread. Steering behavior
// that needs the agent lives in the agent test fixture evals:
// packages/junior-evals/evals/integration/conversation/steering.eval.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getConversationStoppedAtMs } from "@/chat/conversations/session-stop";
import {
  SLACK_BOT_USER_ID,
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import {
  expectChildAgentStopped,
  startRunningChildAgent,
} from "../../fixtures/agent-invocations";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import { getConversationStore } from "@/chat/db";
import type { ConversationStore } from "@/chat/conversations/store";
import { SLACK_STOP_ACK } from "@/chat/ingress/slack-stop";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { hasConversationStop } from "@/chat/task-execution/state";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import type { StateAdapter } from "chat";
import { readProxyProperty } from "../../fixtures/proxy-property";

const CHANNEL_ID = "CSTEER";
const THREAD_TS = "1712345.000100";
const CONVERSATION_ID = `slack:${CHANNEL_ID}:${THREAD_TS}`;

/** Fail the first write of a Conversation's stop request. */
function failFirstStopRequest(state: StateAdapter): StateAdapter {
  let failed = false;
  return new Proxy(state, {
    get(target, prop) {
      if (prop === "set") {
        return async (key: string, value: unknown, ttlMs?: number) => {
          if (
            !failed &&
            key === `junior:conversation:v2:stop:${CONVERSATION_ID}`
          ) {
            failed = true;
            throw new Error("transient stop write failure");
          }
          return target.set(key, value, ttlMs);
        };
      }
      const value = readProxyProperty(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StateAdapter;
}

/** Fail the next read of a Conversation's work state once `failNext` is called. */
function failNextConversationRead(state: StateAdapter) {
  let armed = false;
  return {
    failNext: () => {
      armed = true;
    },
    state: new Proxy(state, {
      get(target, prop) {
        if (prop === "get") {
          return async (key: string) => {
            if (armed && key === `junior:conversation:v2:${CONVERSATION_ID}`) {
              armed = false;
              throw new Error("transient work state read failure");
            }
            return target.get(key);
          };
        }
        const value = readProxyProperty(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as StateAdapter,
  };
}

/** Fail the next execution metadata write once `failNext` is called. */
function failNextExecutionWrite(store: ConversationStore) {
  let armed = false;
  return {
    failNext: () => {
      armed = true;
    },
    store: new Proxy(store, {
      get(target, prop) {
        if (prop === "recordExecution") {
          return async (
            ...args: Parameters<ConversationStore["recordExecution"]>
          ) => {
            if (armed) {
              armed = false;
              throw new Error("transient metadata write failure");
            }
            return await target.recordExecution(...args);
          };
        }
        const value = readProxyProperty(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as ConversationStore,
  };
}

function ingress(
  state: StateAdapter = getStateAdapter(),
  conversationStore?: ConversationStore,
) {
  const adapter = createSlackAdapterFixture();
  const queue = createConversationWorkQueueTestAdapter();
  const services = {
    conversationStore,
    getSlackAdapter: () => adapter,
    queue,
    runtime: createSlackRuntime({ getSlackAdapter: () => adapter }),
    state,
  };
  const send = (args: {
    eventType: "app_mention" | "message";
    text: string;
    ts: string;
  }) =>
    handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          channel: CHANNEL_ID,
          eventType: args.eventType,
          text: args.text,
          threadTs: args.ts === THREAD_TS ? undefined : THREAD_TS,
          ts: args.ts,
        }),
      ),
      services,
    });
  const sendSessionStop = (eventTs: string) =>
    handleSlackWebhookAndFlush({
      request: slackWebhookRequest({
        type: "event_callback",
        team_id: "T123",
        event_id: `Ev_SESSION_STOP_${eventTs}`,
        event: {
          type: "agent_session_stopped",
          channel: CHANNEL_ID,
          event_ts: eventTs,
          streaming_message_ts: [],
          thread_ts: THREAD_TS,
          user: "U123",
        },
      }),
      services,
    });
  return { queue, send, sendSessionStop, state };
}

function statusClears() {
  return slackApiOutbox
    .calls("assistant.threads.setStatus")
    .filter(
      (call) =>
        call.params.channel_id === CHANNEL_ID &&
        call.params.thread_ts === THREAD_TS &&
        call.params.status === "",
    );
}

function stopAcks() {
  return slackApiOutbox
    .messages()
    .filter((call) => call.params.text === SLACK_STOP_ACK);
}

/** Start a queued mention Turn with a running child agent in the thread. */
async function startThreadWork(harness: ReturnType<typeof ingress>) {
  const { queue, send, state } = harness;
  await send({
    eventType: "app_mention",
    text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
    ts: THREAD_TS,
  });
  await state.subscribe(CONVERSATION_ID);
  expect(queue.queuedMessages()).toHaveLength(1);
  return await startRunningChildAgent({
    conversationStore: getConversationStore(),
    idempotencyKey: "slack-stop-child",
    parentConversationId: CONVERSATION_ID,
    queue,
    state,
  });
}

/** Expect a Slack stop that stopped the work and kept the thread. */
async function expectThreadWorkStopped(
  child: Awaited<ReturnType<typeof startThreadWork>>,
  state: ReturnType<typeof ingress>["state"],
) {
  const work = await getConversationWorkState({
    conversationId: CONVERSATION_ID,
    state,
  });
  await expect(
    hasConversationStop({
      conversationId: CONVERSATION_ID,
      runId: work?.execution.runId ?? "",
      state,
    }),
  ).resolves.toBe(true);
  // Only the mention waits, for the worker to drop it. A stop message never
  // enters the mailbox.
  expect(work?.execution.pendingMessages).toHaveLength(1);
  expect(slackApiOutbox.reactionRemovals()).toHaveLength(1);
  expect(stopAcks()).toEqual([
    expect.objectContaining({
      params: expect.objectContaining({
        channel: CHANNEL_ID,
        thread_ts: THREAD_TS,
      }),
    }),
  ]);
  await expectChildAgentStopped(child, state);
  await expect(
    getConversationStoppedAtMs(CONVERSATION_ID),
  ).resolves.toBeDefined();
  // A stop does not opt out: the next person message ends it.
  await expect(state.isSubscribed(CONVERSATION_ID)).resolves.toBe(true);
}

describe("Slack ingress: thread messages", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("accepts a duplicate Slack delivery once", async () => {
    const { queue, send } = ingress();
    const mention = {
      eventType: "app_mention" as const,
      text: `<@${SLACK_BOT_USER_ID}> start the incident summary`,
      ts: THREAD_TS,
    };
    const releaseSend = deferred();
    const sendEntered = queue.holdNextSendUntil(releaseSend.promise);
    const first = send(mention);
    await sendEntered;
    expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
    const duplicate = send(mention);
    releaseSend.resolve();

    for (const response of await Promise.all([first, duplicate])) {
      expect(response.status).toBe(200);
    }
    expect(queue.queuedMessages()).toHaveLength(1);
    expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
  });

  it("stops the active Turn and its child agents from Slack's native stop button and keeps the thread", async () => {
    const harness = ingress();
    // Slack leaves the session in `processing` until the app changes it, so
    // an idle stop still clears the status but has nothing to confirm.
    await expect(
      harness.sendSessionStop("1712345.000900"),
    ).resolves.toMatchObject({ status: 200 });
    expect(statusClears()).toHaveLength(1);
    expect(stopAcks()).toHaveLength(0);

    const child = await startThreadWork(harness);
    await expect(
      harness.sendSessionStop("1712345.000950"),
    ).resolves.toMatchObject({ status: 200 });
    const stoppedAtMs = await getConversationStoppedAtMs(CONVERSATION_ID);
    // Slack's retry of the same press stops nothing more.
    await expect(
      harness.sendSessionStop("1712345.000950"),
    ).resolves.toMatchObject({ status: 200 });

    expect(statusClears()).toHaveLength(2);
    await expectThreadWorkStopped(child, harness.state);
    // The press time is the stop time.
    expect(stoppedAtMs).toBe(1_712_345_000);
    await expect(getConversationStoppedAtMs(CONVERSATION_ID)).resolves.toBe(
      stoppedAtMs,
    );
  });

  it("stops the active Turn and its child agents from the `stop` keyword the same way, once per message", async () => {
    const harness = ingress(failFirstStopRequest(getStateAdapter()));
    const child = await startThreadWork(harness);
    const stop = {
      text: `<@${SLACK_BOT_USER_ID}> stop`,
      ts: "1712345.000200",
    };
    // A stop that fails asks Slack to retry, and the retry stops the work.
    await expect(
      harness.send({ ...stop, eventType: "message" }),
    ).resolves.toMatchObject({ status: 503 });
    expect(stopAcks()).toHaveLength(0);
    await expect(
      harness.send({ ...stop, eventType: "message" }),
    ).resolves.toMatchObject({ status: 200 });
    const stoppedAtMs = await getConversationStoppedAtMs(CONVERSATION_ID);
    // Slack sends a mention as both `message` and `app_mention`.
    await expect(
      harness.send({ ...stop, eventType: "app_mention" }),
    ).resolves.toMatchObject({ status: 200 });

    // The failed stop and its retry each clear the status.
    expect(statusClears()).toHaveLength(2);
    await expectThreadWorkStopped(child, harness.state);
    await expect(getConversationStoppedAtMs(CONVERSATION_ID)).resolves.toBe(
      stoppedAtMs,
    );
  });

  it("keeps a mention sent after a `stop` that Slack retries", async () => {
    const harness = ingress(failFirstStopRequest(getStateAdapter()));
    await startThreadWork(harness);
    // Each message is sent at least 1 ms apart, the precision of a send time.
    const stop = {
      eventType: "message" as const,
      text: `<@${SLACK_BOT_USER_ID}> stop`,
      ts: "1712345.0020",
    };
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 503 });
    await harness.send({
      eventType: "app_mention",
      text: `<@${SLACK_BOT_USER_ID}> check the logs`,
      ts: "1712345.0030",
    });
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 200 });

    // The stop is as old as its message, so the retry drops only the mention
    // sent before it. The worker runs the newer mention.
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state: harness.state,
    });
    const [first, newer] = work?.execution.pendingMessages ?? [];
    expect(newer?.createdAtMs).toBe(1_712_345_003);
    await expect(
      harness.state.get(`junior:conversation:v2:stop:${CONVERSATION_ID}`),
    ).resolves.toMatchObject({
      inboundMessageIds: [first?.inboundMessageId],
    });
    expect(stopAcks()).toHaveLength(1);
  });

  it("lets Slack retry a `stop` keyword whose claim fails to save", async () => {
    const metadata = failNextExecutionWrite(getConversationStore());
    const harness = ingress(getStateAdapter(), metadata.store);
    const child = await startThreadWork(harness);
    const stop = {
      eventType: "message" as const,
      text: `<@${SLACK_BOT_USER_ID}> stop`,
      ts: "1712345.000200",
    };
    // The claim lands, then its metadata write fails.
    metadata.failNext();
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 503 });
    expect(stopAcks()).toHaveLength(0);

    // The failed claim is released, so the retry stops the work.
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 200 });
    await expectThreadWorkStopped(child, harness.state);
  });

  it("keeps a `stop` keyword's claim when the stop fails after it landed", async () => {
    const reads = failNextConversationRead(getStateAdapter());
    const harness = ingress(reads.state);
    const child = await startThreadWork(harness);
    const stop = {
      eventType: "message" as const,
      text: `<@${SLACK_BOT_USER_ID}> stop`,
      ts: "1712345.000200",
    };
    // The stop request is saved, then its wake fails.
    harness.queue.rejectSends();
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 503 });
    harness.queue.allowSends();
    const stoppedAtMs = await getConversationStoppedAtMs(CONVERSATION_ID);
    expect(stoppedAtMs).toBeDefined();
    await expectChildAgentStopped(child, harness.state);

    // A redelivery whose claim check fails keeps the saved claim.
    reads.failNext();
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 503 });

    // The next redelivery is a duplicate, so it cannot stop newer work.
    await expect(harness.send(stop)).resolves.toMatchObject({ status: 200 });
    expect(stopAcks()).toHaveLength(0);
    await expect(getConversationStoppedAtMs(CONVERSATION_ID)).resolves.toBe(
      stoppedAtMs,
    );
  });
});
