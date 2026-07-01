import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { authTestOk } from "../../fixtures/slack/factories/api";
import {
  queueSlackApiError,
  queueSlackApiResponse,
} from "../../msw/handlers/slack-api";
import {
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

function failIsSubscribed(state: StateAdapter): StateAdapter {
  return new Proxy(state, {
    get(target, prop, receiver) {
      if (prop === "isSubscribed") {
        return async () => {
          throw new Error("transient state read failure");
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StateAdapter;
}

describe("Slack webhook persistence contract", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  it.each([
    {
      label: "app mention",
      envelope: slackEnvelope({
        text: `<@${SLACK_BOT_USER_ID}> deploy status`,
      }),
    },
    {
      label: "direct message",
      envelope: slackEnvelope({
        channel: "D123",
        eventType: "message",
        text: "deploy status",
      }),
    },
  ])(
    "returns retryable response when $label persistence fails",
    async (args) => {
      const queue = createConversationWorkQueueTestAdapter();
      queue.rejectSends();
      const state = getStateAdapter();
      await state.connect();
      const slackAdapter = createSlackAdapterFixture();

      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(args.envelope),
        services: {
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
          state,
        },
      });

      expect(response.status).toBe(503);
      expect(queue.queuedMessages()).toEqual([]);
    },
  );

  it("returns retryable response when a routing-state read fails before persistence", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({ eventType: "message", text: "no mention here" }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state: failIsSubscribed(state),
      },
    });

    expect(response.status).toBe(503);
    expect(queue.queuedMessages()).toEqual([]);
  });

  it("acks unsubscribed channel chatter without retry when routing state is healthy", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({ eventType: "message", text: "no mention here" }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.queuedMessages()).toEqual([]);
  });

  it("returns retryable response for unresolved bot identity and recovers on redelivery", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    // No configured botUserId: identity must come from auth.test at initialize.
    const slackAdapter = createJuniorSlackAdapter({
      botToken: "slack-bot-fixture",
      signingSecret: SLACK_SIGNING_SECRET,
    });
    queueSlackApiError("auth.test", { error: "invalid_auth" });
    const services = {
      getSlackAdapter: () => slackAdapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
    const envelope = slackEnvelope({
      text: `<@${SLACK_BOT_USER_ID}> deploy status`,
    });

    const failedResponse = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(envelope),
      services,
    });

    expect(failedResponse.status).toBe(503);
    expect(queue.queuedMessages()).toEqual([]);

    // Slack redelivers: initialization must not have cached the broken
    // adapter, so a healthy auth.test resolves identity and the message routes.
    queueSlackApiResponse("auth.test", {
      body: authTestOk({ userId: SLACK_BOT_USER_ID }),
    });

    const retriedResponse = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(envelope),
      services,
    });

    expect(retriedResponse.status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(1);
  });
});
