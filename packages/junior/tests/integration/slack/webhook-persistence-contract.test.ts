import type { StateAdapter } from "chat";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getChatConfig } from "@/chat/config";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import { stopConversationTree } from "@/chat/conversations/session-stop";
import { getConversationStoppedAtMs } from "@/chat/conversations/stop-state";
import { withConversationEventLock } from "@/conversation-events/lock";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { claimTurn } from "@/core/turn/state";
import { juniorIdentities, juniorTurnInbox, juniorTurns } from "@/db/schema";
import { createEngineContext } from "@/turn-steps/engine-context";
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
  deferred,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { readProxyProperty } from "../../fixtures/proxy-property";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { patchConfig } from "../../fixtures/config";

/** Read the Identity id that Slack ingress saved for one author. */
async function slackIdentityId(userId: string): Promise<string> {
  const rows = await getDb()
    .select({ id: juniorIdentities.id })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "slack"),
        eq(juniorIdentities.providerSubjectId, userId),
      ),
    );
  const id = rows[0]?.id;
  if (!id) throw new Error(`No Slack Identity for ${userId}`);
  return id;
}

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
  });
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

  it("accepts a mention even when its receipt reaction is rate limited", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    queueSlackApiError("reactions.add", {
      error: "ratelimited",
      status: 429,
      headers: { "retry-after": "60" },
    });

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({ text: `<@${SLACK_BOT_USER_ID}> deploy status` }),
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
    expect(slackApiOutbox.reactionAdds()).toHaveLength(1);
    expect(slackApiOutbox.reactionAdds()[0]?.params).toMatchObject({
      channel: "C123",
      name: "eyes",
      timestamp: "1712345.0001",
    });
  });

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

  it("acks a mention that Junior posted without queueing work", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> do not respond`,
          user: SLACK_BOT_USER_ID,
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
  });

  it("stores subscribed non-mention messages as history without worker work when passive routing is off", async () => {
    patchConfig({ experimental: {} });
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const threadTs = "1712345.000800";
    const threadId = `slack:C123:${threadTs}`;
    await state.subscribe(threadId);

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: "message",
          text: "follow-up without another mention",
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
    const history =
      await getConversationEventStore().loadMessageHistory(threadId);
    expect(history.events).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          type: "message",
          text: "follow-up without another mention",
          authorIdentityId: await slackIdentityId("U123"),
          meta: expect.objectContaining({
            replied: false,
            skippedReason: "passive_disabled:passive-routing",
          }),
        }),
      }),
    ]);
  });

  it("keeps passive-routing history on the bound Conversation", async () => {
    patchConfig({ experimental: {} });
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const conversationStore = getConversationStore();
    const conversationId = "agent-dispatch:bound-passive-history";
    const threadTs = "1712345.000820";
    const threadId = `slack:C123:${threadTs}`;
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
    await state.subscribe(threadId);

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          eventType: "message",
          text: "bound thread follow-up",
          threadTs,
          ts: "1712345.000821",
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
    await expect(
      getConversationEventStore().loadMessageHistory(conversationId),
    ).resolves.toEqual({
      events: [
        expect.objectContaining({
          data: expect.objectContaining({
            type: "message",
            text: "bound thread follow-up",
          }),
        }),
      ],
      historyFromSeq: expect.any(Number),
    });
    await expect(
      getConversationEventStore().loadMessageHistory(threadId),
    ).resolves.toEqual({
      events: [],
      historyFromSeq: expect.any(Number),
    });
  });

  it("keeps a stopped thread subscribed without enqueuing mailbox work when passive routing is off", async () => {
    patchConfig({ experimental: {} });
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const threadTs = "1712345.000810";
    const canonicalThreadId = `slack:C123:${threadTs}`;
    await state.subscribe(canonicalThreadId);

    for (const message of [
      { text: "<@UOTHER> stop", ts: "1712345.000811" },
      { text: `<@${SLACK_BOT_USER_ID}> stop`, ts: "1712345.000812" },
    ]) {
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(
          slackEnvelope({
            eventType: "message",
            text: message.text,
            threadTs,
            ts: message.ts,
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
      await expect(state.isSubscribed(canonicalThreadId)).resolves.toBe(true);
    }
    // Stop is control flow, not a mailbox message: it never enters the
    // durable Run queue, so the stop starts no Turn.
    expect(queue.queuedMessages()).toEqual([]);
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
    const work = await getConversationWorkState({ conversationId, state });
    expect(work?.execution.pendingMessages).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          authorId: "U123",
          authorIdentityId: await slackIdentityId("U123"),
        }),
      }),
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

/** Read the core Turns and inputs of a Conversation. */
async function coreRows(conversationId: string) {
  const [turns, inputs] = await Promise.all([
    getDb()
      .select({ id: juniorTurns.id, state: juniorTurns.state })
      .from(juniorTurns)
      .where(eq(juniorTurns.conversationId, conversationId)),
    getDb()
      .select()
      .from(juniorTurnInbox)
      .where(eq(juniorTurnInbox.conversationId, conversationId)),
  ]);
  return { turns, inputs };
}

describe("Slack webhook Turn engine switch", () => {
  const conversationId = "slack:C123:1712345.0001";
  const mention = slackEnvelope({
    text: `<@${SLACK_BOT_USER_ID}> deploy status`,
  });
  // Core publishes each Turn message to Vercel Queues. The server keeps them
  // with no consumer, so a test reads only the stored Turn.
  let queueServer: LocalVercelQueueServer;

  beforeAll(async () => {
    queueServer = await startLocalVercelQueueServer({ consumers: [] });
  });

  afterAll(async () => {
    await queueServer.close();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
  });

  async function sendSlack(
    envelope: unknown,
    queue = createConversationWorkQueueTestAdapter(),
  ) {
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(envelope),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });
    expect(response.status).toBe(200);
    return { queue, state };
  }

  function useCoreEngine() {
    patchConfig({
      turnEngine: "core",
      queue: { ...getChatConfig().queue, apiUrl: queueServer.url.href },
    });
  }

  it("sends a mention to main's mailbox by default", async () => {
    const { queue, state } = await sendSlack(mention);

    expect(queue.queuedMessages()).toEqual([
      expect.objectContaining({ conversationId }),
    ]);
    const work = await getConversationWorkState({ conversationId, state });
    expect(work?.execution.pendingMessages).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          text: expect.stringContaining("deploy status"),
        }),
      }),
    ]);
    await expect(coreRows(conversationId)).resolves.toEqual({
      turns: [],
      inputs: [],
    });
  });

  it("schedules a mention as one core input on the core Turn engine", async () => {
    useCoreEngine();

    const { queue, state } = await sendSlack(mention);
    // Slack sends the event again.
    await sendSlack(mention, queue);

    expect(queue.queuedMessages()).toEqual([]);
    await expect(
      getConversationWorkState({ conversationId, state }),
    ).resolves.toBeUndefined();
    const { turns, inputs } = await coreRows(conversationId);
    expect(turns).toEqual([{ id: expect.any(String), state: "queued" }]);
    expect(inputs).toEqual([
      expect.objectContaining({
        turnId: turns[0]!.id,
        actorIdentityId: await slackIdentityId("U123"),
        idempotencyKey: `slack:T123:${conversationId}:1712345.0001`,
        payload: {
          text: `@${SLACK_BOT_USER_ID} deploy status`,
          actor: { platform: "slack", teamId: "T123", userId: "U123" },
        },
        destination: {
          platform: "slack",
          teamId: "T123",
          channelId: "C123",
          threadTs: "1712345.0001",
        },
        source: {
          kind: "slack",
          teamId: "T123",
          channelId: "C123",
          messageTs: "1712345.0001",
          threadTs: "1712345.0001",
          visibility: "private",
        },
        // The Slack ts, in seconds.
        sentAt: new Date(1_712_345_000),
      }),
    ]);
  });

  it("cancels the running core Turn when the thread stops on the core Turn engine", async () => {
    useCoreEngine();
    const { queue } = await sendSlack(mention);
    const [turn] = (await coreRows(conversationId)).turns;
    await claimTurn(createEngineContext(getChatConfig()), turn!.id);

    await sendSlack(
      slackEnvelope({
        text: `<@${SLACK_BOT_USER_ID}> stop`,
        threadTs: "1712345.0001",
        ts: "1712345.0002",
      }),
      queue,
    );

    await expect(coreRows(conversationId)).resolves.toMatchObject({
      turns: [{ id: turn!.id, state: "cancelled" }],
    });
    expect(queue.queuedMessages()).toEqual([]);
  });

  it("stops core Turns by sent time on the core Turn engine, and drops a mention sent before the stop", async () => {
    useCoreEngine();
    const threadMessage = (text: string, ts: string) =>
      slackEnvelope({
        text: `<@${SLACK_BOT_USER_ID}> ${text}`,
        threadTs: "1712345.0001",
        ts,
      });
    const inputTurns = async () =>
      Object.fromEntries(
        (await coreRows(conversationId)).inputs.map((input) => [
          input.idempotencyKey.split(":").at(-1),
          input.turnId,
        ]),
      );
    const stateOf = async (turnId: string | undefined) =>
      (await coreRows(conversationId)).turns.find((turn) => turn.id === turnId)
        ?.state;
    const { queue } = await sendSlack(mention);
    const [first] = (await coreRows(conversationId)).turns;
    await claimTurn(createEngineContext(getChatConfig()), first!.id);
    await sendSlack(threadMessage("and the canary", "1712345.0030"), queue);

    // Slack delivers the stop, sent between the two mentions, after both.
    await sendSlack(threadMessage("stop", "1712345.0020"), queue);

    // The mention sent before the stop drops with its Turn. The later one
    // waits in a new Turn and ends the stop.
    let turns = await inputTurns();
    expect(turns["1712345.0001"]).toBe(first!.id);
    await expect(stateOf(first!.id)).resolves.toBe("cancelled");
    expect(turns["1712345.0030"]).not.toBe(first!.id);
    await expect(stateOf(turns["1712345.0030"])).resolves.toBe("queued");
    await expect(
      getConversationStoppedAtMs(conversationId),
    ).resolves.toBeUndefined();

    await sendSlack(threadMessage("stop", "1712345.0040"), queue);
    await expect(stateOf(turns["1712345.0030"])).resolves.toBe("cancelled");
    // A mention sent before this stop but delivered after it starts no Turn
    // and leaves the Conversation stopped.
    await sendSlack(threadMessage("check the deploy", "1712345.0035"), queue);
    expect(Object.keys(await inputTurns())).not.toContain("1712345.0035");
    expect(
      (await coreRows(conversationId)).turns.filter(
        (turn) => turn.state === "queued",
      ),
    ).toEqual([]);
    await expect(getConversationStoppedAtMs(conversationId)).resolves.toBe(
      1_712_345_004,
    );

    // A mention sent after the stop runs and ends it.
    await sendSlack(
      threadMessage("check the next deploy", "1712345.0050"),
      queue,
    );
    turns = await inputTurns();
    await expect(stateOf(turns["1712345.0050"])).resolves.toBe("queued");
    await expect(
      getConversationStoppedAtMs(conversationId),
    ).resolves.toBeUndefined();
  });

  it("drops a mention sent before a stop that saves while core intake waits for the Conversation lock", async () => {
    useCoreEngine();
    const { queue } = await sendSlack(mention);
    const stopping = deferred();
    const locked = deferred();
    // The test holds the lock that core intake waits for, and stops the
    // Conversation under it. So the stop saves after intake starts, and
    // before intake schedules.
    const stop = withConversationEventLock(
      getSqlExecutor(),
      conversationId,
      async () => {
        locked.resolve();
        await stopping.promise;
        await stopConversationTree([conversationId], {
          sentAtOrBeforeMs: 1_712_345_002,
          stoppedAtMs: 1_712_345_002,
        });
      },
    );
    await locked.promise;
    const sending = sendSlack(
      slackEnvelope({
        text: `<@${SLACK_BOT_USER_ID}> check the deploy`,
        threadTs: "1712345.0001",
        ts: "1712345.0015",
      }),
      queue,
    );
    // Time for intake to reach the lock. A read of the stop before the lock
    // would miss it then.
    await new Promise((resolve) => setTimeout(resolve, 200));
    stopping.resolve();
    await stop;
    await sending;

    const { turns, inputs } = await coreRows(conversationId);
    expect(inputs.map((input) => input.idempotencyKey)).not.toContainEqual(
      expect.stringContaining("1712345.0015"),
    );
    expect(turns.map((turn) => turn.state)).toEqual(["cancelled"]);
    await expect(getConversationStoppedAtMs(conversationId)).resolves.toBe(
      1_712_345_002,
    );
  });
});
