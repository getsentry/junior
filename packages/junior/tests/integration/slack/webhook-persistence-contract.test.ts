import type { StateAdapter } from "chat";
import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
} from "@/chat/db";
import { setExperimentalFeatures } from "@/chat/experimental";
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
import { readProxyProperty } from "../../fixtures/proxy-property";

function failIsSubscribed(state: StateAdapter): StateAdapter {
  return new Proxy(state, {
    get(target, prop) {
      if (prop === "isSubscribed") {
        return async () => {
          throw new Error("transient state read failure");
        };
      }
      const value = readProxyProperty(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as StateAdapter;
}

describe("Slack webhook persistence contract", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
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

  it.each([
    {
      label: "app_mention",
      eventType: "app_mention" as const,
    },
    {
      label: "message",
      eventType: "message" as const,
    },
  ])(
    "acks a code-only bot mention on $label without queueing work",
    async (args) => {
      const queue = createConversationWorkQueueTestAdapter();
      const state = getStateAdapter();
      await state.connect();
      const slackAdapter = createSlackAdapterFixture();
      const codeOnlyText = "docs say use `" + `<@${SLACK_BOT_USER_ID}>` + "`";

      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            eventType: args.eventType,
            text: codeOnlyText,
          }),
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
    },
  );

  it("records subscribed chatter as context without queueing when passive routing is off", async () => {
    setExperimentalFeatures(undefined);
    try {
      const queue = createConversationWorkQueueTestAdapter();
      const state = getStateAdapter();
      await state.connect();
      const slackAdapter = createSlackAdapterFixture();
      const threadTs = "1712345.000800";
      await state.subscribe(`slack:C123:${threadTs}`);

      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            eventType: "message",
            text: "passive thread chatter",
            threadTs,
            ts: "1712345.000801",
          }),
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
      const history = await getConversationEventStore().loadMessageHistory(
        `slack:C123:${threadTs}`,
      );
      expect(history.events).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            type: "message",
            text: "passive thread chatter",
            meta: expect.objectContaining({
              replied: false,
              skippedReason: "passive_disabled:passive-routing",
            }),
          }),
        }),
      ]);
    } finally {
      setExperimentalFeatures({ "passive-routing": true, subagents: true });
    }
  });

  it("still persists subscribed thread opt-out when passive routing is off", async () => {
    setExperimentalFeatures(undefined);
    try {
      const queue = createConversationWorkQueueTestAdapter();
      const state = getStateAdapter();
      await state.connect();
      const slackAdapter = createSlackAdapterFixture();
      const threadTs = "1712345.000810";
      await state.subscribe(`slack:C123:${threadTs}`);

      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            eventType: "message",
            text: "!stop",
            threadTs,
            ts: "1712345.000811",
          }),
        ),
        services: {
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
          state,
        },
      });

      expect(response.status).toBe(200);
      expect(queue.queuedMessages()).toHaveLength(1);
    } finally {
      setExperimentalFeatures({ "passive-routing": true, subagents: true });
    }
  });

  it("routes a provider conversation into its bound durable conversation", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const conversationStore = getConversationStore();
    const conversationId = "agent-dispatch:bound-provider-conversation";
    const threadTs = "1712345.000900";
    await conversationStore.recordActivity({
      conversationId,
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
      },
      nowMs: 1_000,
    });
    await conversationStore.bindProviderConversation({
      conversationId,
      provider: "slack",
      providerDestinationId: "C123",
      providerTenantId: "T123",
      providerConversationId: threadTs,
    });

    const canonicalThreadId = `slack:C123:${threadTs}`;
    await state.subscribe(canonicalThreadId);

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: "message",
          text: "follow up without another mention",
          threadTs,
          ts: "1712345.001000",
        }),
      ),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ conversationId }),
    ]);
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
