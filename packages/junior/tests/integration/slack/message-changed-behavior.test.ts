import { describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { Message } from "chat";
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
