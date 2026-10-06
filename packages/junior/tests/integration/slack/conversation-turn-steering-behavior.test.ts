// Ingress rules for Slack messages that reach a thread. Steering behavior
// that needs the agent lives in the agent test fixture evals:
// packages/junior-evals/evals/integration/conversation/steering.eval.ts
import { ThreadImpl } from "chat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SLACK_BOT_USER_ID,
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import { createSlackRuntime } from "@/chat/app/factory";
import { subscribeSlackThreadForMessage } from "@/chat/slack/thread-stop";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";

const CHANNEL_ID = "CSTEER";
const THREAD_TS = "1712345.000100";
const CONVERSATION_ID = `slack:${CHANNEL_ID}:${THREAD_TS}`;

function ingress() {
  const adapter = createSlackAdapterFixture();
  const queue = createConversationWorkQueueTestAdapter();
  const state = getStateAdapter();
  const services = {
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
  return { adapter, queue, send, state };
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

  it("ignores a late stop that arrives after a newer mention subscribed the thread", async () => {
    const { adapter, queue, send, state } = ingress();
    // The worker subscribes the thread for the mention at THREAD_TS.
    await subscribeSlackThreadForMessage({
      messageCreatedAtMs: Number(THREAD_TS) * 1000,
      state,
      thread: new ThreadImpl({
        adapter,
        channelId: `slack:${CHANNEL_ID}`,
        id: CONVERSATION_ID,
        isDM: false,
        stateAdapter: state,
      }),
    });

    // A "stop" timestamped before that mention arrives out of order.
    await expect(
      send({ eventType: "message", text: "stop", ts: "1712344.000100" }),
    ).resolves.toMatchObject({ status: 200 });

    await expect(state.isSubscribed(CONVERSATION_ID)).resolves.toBe(true);
    expect(queue.hasQueuedMessages()).toBe(false);
    expect(
      slackApiOutbox
        .messages()
        .some((call) =>
          String(call.params.text ?? "").includes("stay out of this thread"),
        ),
    ).toBe(false);
  });
});
