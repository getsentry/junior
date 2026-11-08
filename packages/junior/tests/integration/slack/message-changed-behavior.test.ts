import { afterEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message } from "chat";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { getConversationEventStore } from "@/chat/db";
import { enqueueEventNotification } from "@/chat/events/notification";
import { createWatch } from "@/chat/events/store";
import {
  ackMessages,
  getConversationWorkState,
  releaseConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import { closeConversationFixture } from "../../fixtures/conversation";
import {
  CONVERSATION_ID,
  SLACK_BOT_USER_ID,
  createConversationWorkHarness,
  handleSlackWebhookAndFlush,
  slackEditEnvelope,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { handleChatSdkPlatformWebhook } from "@/handlers/webhooks";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT";
const slackWebhookClient = createSlackWebhookTestClient({
  signingSecret: SIGNING_SECRET,
});

describe("Slack behavior: message_changed webhook ingress", () => {
  it("ignores an edit that adds a Junior mention", async () => {
    const bot = new JuniorChat({
      userName: "junior",
      adapters: {
        slack: createJuniorSlackAdapter({
          botToken: "xoxb-test",
          botUserId: BOT_USER_ID,
          signingSecret: SIGNING_SECRET,
        }),
      },
      state: createMemoryState(),
    });
    const handledMessages: Array<Pick<Message, "id" | "text">> = [];
    const waitUntil = slackWebhookClient.waitUntil();

    bot.onDirectMessage(async (_thread, message) => {
      handledMessages.push({ id: message.id, text: message.text });
    });

    const original = slackEventsApiEnvelope({
      eventType: "message",
      channel: "D12345",
      ts: "1700000100.000100",
      text: "hello there",
    });
    const edit = {
      ...original,
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "D12345",
        hidden: true,
        message: {
          type: "message",
          user: "U123",
          text: `<@${BOT_USER_ID}> hello there`,
          ts: "1700000100.000100",
        },
        previous_message: {
          type: "message",
          user: "U123",
          text: "hello there",
          ts: "1700000100.000100",
        },
      },
    };

    await handleChatSdkPlatformWebhook(
      slackWebhookClient.event(original),
      "slack",
      waitUntil.fn,
      bot,
    );
    await handleChatSdkPlatformWebhook(
      slackWebhookClient.event(edit),
      "slack",
      waitUntil.fn,
      bot,
    );
    await waitUntil.flush();

    expect(handledMessages).toEqual([
      { id: "1700000100.000100", text: "hello there" },
    ]);
  });
});

const ORIGINAL_ID = `slack:T123:${CONVERSATION_ID}:1712345.0001`;
const ASK = `<@${SLACK_BOT_USER_ID}> inspect the deploy`;
const EDITED_ASK = `<@${SLACK_BOT_USER_ID}> inspect the rollback`;

/**
 * Compose production Slack ingress, mailbox, and worker. An edit never starts
 * a Turn, so the agent runner fails the test when it runs.
 */
async function editHarness() {
  const work = await createConversationWorkHarness({
    run: async () => {
      throw new Error("An edit started a Turn");
    },
  });
  const services = {
    getSlackAdapter: () => work.adapter,
    queue: work.queue,
    runtime: work.runtime,
    state: work.state,
  };
  const post = async (body: unknown) =>
    await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(body),
      services,
    });
  return {
    ...work,
    drain: async () => {
      while (work.queue.hasQueuedMessages()) {
        await work.process(work.queue.takeMessage());
      }
    },
    edit: async (input: Parameters<typeof slackEditEnvelope>[0]) =>
      await post(slackEditEnvelope(input)),
    send: async () => await post(slackEnvelope({ text: ASK })),
    /** Claim all pending input as a Turn does. Returns the lease token. */
    startTurn: async () => {
      const lease = await startConversationWork({
        conversationId: CONVERSATION_ID,
        state: work.state,
      });
      if (lease.status !== "acquired") throw new Error("Expected work lease");
      await ackMessages({
        conversationId: CONVERSATION_ID,
        inboundMessageIds: [ORIGINAL_ID],
        leaseToken: lease.leaseToken,
        state: work.state,
      });
      return lease.leaseToken;
    },
    endTurn: async (leaseToken: string) =>
      await releaseConversationWork({
        conversationId: CONVERSATION_ID,
        leaseToken,
        state: work.state,
      }),
  };
}

async function pendingMessages() {
  return (await getConversationWorkState({ conversationId: CONVERSATION_ID }))
    ?.messages;
}

async function editedMessageTexts(): Promise<string[]> {
  const history =
    await getConversationEventStore().loadMessageHistory(CONVERSATION_ID);
  return projectConversationMessages(history)
    .filter((message) => message.meta?.skippedReason === "edited message")
    .map((message) => message.text);
}

describe("Edits through conversation work", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("updates a pending message in place", async () => {
    const harness = await editHarness();
    await harness.send();
    await harness.edit({ previousText: ASK, text: EDITED_ASK });

    const messages = await pendingMessages();
    expect(messages).toHaveLength(1);
    expect(messages?.[0]).toMatchObject({ inboundMessageId: ORIGINAL_ID });
    expect(messages?.[0]?.input.text).toContain("inspect the rollback");
    expect(messages?.[0]?.input.metadata).not.toHaveProperty("edit");
  });

  it("sends an edit to the running Turn, then saves it when no Turn takes it", async () => {
    const harness = await editHarness();
    await harness.send();
    const leaseToken = await harness.startTurn();
    await harness.edit({ previousText: ASK, text: EDITED_ASK });

    // The running Turn drains interrupts at its next boundary.
    expect(await pendingMessages()).toEqual([
      expect.objectContaining({
        delivery: "interrupt",
        input: expect.objectContaining({
          metadata: expect.objectContaining({
            edit: { inboundMessageId: ORIGINAL_ID },
          }),
        }),
      }),
    ]);

    // This Turn ends before its drain, so the edit is saved, not run.
    await harness.endTurn(leaseToken);
    await harness.drain();
    expect(await pendingMessages()).toEqual([]);
    const saved = await editedMessageTexts();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain("<message-edit");
    expect(saved[0]).toContain("inspect the rollback");
  });

  it("saves an idle edit as context without a Turn", async () => {
    const harness = await editHarness();
    await harness.send();
    await harness.endTurn(await harness.startTurn());
    await harness.drain();
    await harness.edit({ previousText: ASK, text: EDITED_ASK });
    await harness.drain();

    expect(await pendingMessages()).toEqual([]);
    expect(await editedMessageTexts()).toEqual([
      expect.stringContaining("inspect the rollback"),
    ]);
  });

  it("ignores bot edits, edits without new text, and edits of unknown threads", async () => {
    const harness = await editHarness();
    await harness.edit({
      previousText: "hi",
      text: "hello",
      ts: "1712345.0099",
    });
    expect(harness.queue.hasQueuedMessages()).toBe(false);

    await harness.send();
    await harness.endTurn(await harness.startTurn());
    await harness.drain();
    await harness.edit({ botId: "B123", previousText: ASK, text: EDITED_ASK });
    await harness.edit({ previousText: ASK, text: ASK });
    await harness.edit({ editedTs: null, previousText: ASK, text: EDITED_ASK });

    expect(harness.queue.hasQueuedMessages()).toBe(false);
    expect(await pendingMessages()).toEqual([]);
  });

  it("saves a watched GitHub edit as context without a Turn", async () => {
    const harness = await editHarness();
    await harness.send();
    await harness.endTurn(await harness.startTurn());
    await harness.drain();
    const watch = await createWatch(
      {
        conversationId: CONVERSATION_ID,
        events: ["pull_request.comment.created"],
        expiresAtMs: Date.now() + 60_000,
        identifier: "getsentry/junior#691",
        intent: "Address review comments.",
        label: "GitHub PR getsentry/junior#691",
        namespace: "github",
        resourceType: "pull_request",
      },
      { state: harness.state },
    );
    await enqueueEventNotification({
      event: {
        edit: true,
        eventKey: "github:delivery-edit:pull_request.comment.created",
        eventType: "pull_request.comment.created",
        identifier: "getsentry/junior#691",
        namespace: "github",
        occurredAtMs: Date.now(),
        trustedSummary: "Edited: GitHub PR getsentry/junior#691 comment.",
        untrustedText: "add load coverage",
      },
      queue: harness.queue,
      state: harness.state,
      subscription: watch,
    });
    await harness.drain();

    expect(await pendingMessages()).toEqual([]);
    expect(await editedMessageTexts()).toEqual([
      expect.stringContaining("add load coverage"),
    ]);
  });
});
