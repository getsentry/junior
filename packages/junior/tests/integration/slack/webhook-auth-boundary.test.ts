import { createMemoryState } from "@chat-adapter/state-memory";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getConversationEventStore } from "@/chat/db";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { runWithWorkspaceTeamId } from "@/chat/ingress/workspace-membership";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { createTestMessage } from "../../fixtures/slack-harness";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";

const SIGNING_SECRET = "test-signing-secret";

describe("Slack webhook auth boundary", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("drops unknown authors before replies or stored input", async () => {
    const channel = "C123";
    const state = createMemoryState();
    await state.connect();
    const threadTs = "1712345.0001";
    const threadId = `slack:${channel}:${threadTs}`;
    await state.subscribe(threadId);
    const queue = createConversationWorkQueueTestAdapter();
    const adapter = createSlackAdapterFixture();
    const envelope = slackEnvelope({
      channel,
      threadTs,
    });
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };

    for (const userTeam of [undefined, 123]) {
      const rejected = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest({
          ...envelope,
          event: { ...envelope.event, user_team: userTeam },
        }),
        services,
      });
      expect(rejected.status).toBe(200);
    }
    expect(queue.queuedMessages()).toEqual([]);
    expect(
      await getConversationWorkState({ conversationId: threadId, state }),
    ).toBeUndefined();
    expect(
      (await getConversationEventStore().loadMessageHistory(threadId)).events,
    ).toEqual([]);
    expect(slackApiOutbox.messages()).toEqual([]);
    expect(slackApiOutbox.reactions()).toEqual([]);

    const accepted = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(envelope),
      services,
    });
    expect(accepted.status).toBe(200);
    expect(queue.queuedMessages()).toHaveLength(1);
    await state.disconnect();
  });

  it.each(["message", "factory"] as const)(
    "checks membership before SDK routing for a %s",
    async (mode) => {
      const state = createMemoryState();
      const adapter = createSlackAdapterFixture();
      const bot = new JuniorChat({
        userName: "junior",
        adapters: { slack: adapter },
        state,
      });
      const handled: string[] = [];
      bot.onDirectMessage(async (_thread, message) => {
        handled.push(message.text);
      });
      await bot.initialize();
      const client = createSlackWebhookTestClient({
        signingSecret: SIGNING_SECRET,
      });
      const waitUntil = client.waitUntil();
      const threadId = "slack:D123:1712345.0001";

      for (const [index, userTeam] of [undefined, "T123"].entries()) {
        const message = createTestMessage({
          id: `1712345.000${index + 1}`,
          threadId,
          text: userTeam ?? "unknown",
          author: { userId: "U123" },
          raw: { user_team: userTeam },
        });
        await runWithWorkspaceTeamId("T123", () =>
          bot.processMessage(
            adapter,
            threadId,
            mode === "factory" ? async () => message : message,
            { waitUntil: waitUntil.fn },
          ),
        );
        await waitUntil.flush();
      }

      expect(handled).toEqual(["T123"]);
      await bot.shutdown();
    },
  );

  it("rejects malformed signed payloads before durable state is required", async () => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const adapter = createSlackAdapterFixture();
    const envelope = slackEnvelope({});
    for (const payload of [
      null,
      { ...envelope, event: { ...envelope.event, channel: 123 } },
    ]) {
      const response = await handleSlackWebhook({
        request: slackWebhookRequest(payload),
        waitUntil: waitUntil.fn,
        services: {
          getSlackAdapter: () => adapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
        },
      });
      expect(response.status).toBe(400);
    }
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
    expect(slackApiOutbox.messages()).toEqual([]);
    expect(slackApiOutbox.reactions()).toEqual([]);
  });

  it("rejects invalid Slack signatures before durable state is required", async () => {
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const waitUntil = client.waitUntil();
    const adapter = createJuniorSlackAdapter({
      botToken: "xoxb-test-token",
      botUserId: "U0BOT",
      signingSecret: SIGNING_SECRET,
    });

    const response = await handleSlackWebhook({
      request: client.invalidSignature({ type: "event_callback" }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => adapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
      },
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Invalid signature");
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(0);
  });
});
