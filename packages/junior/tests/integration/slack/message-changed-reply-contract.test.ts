import { createTestDestination } from "../../fixtures/slack-harness";
import { describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import type { ReplyExecutorServices } from "@/chat/runtime/reply-executor";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { handleChatSdkPlatformWebhook } from "@/handlers/webhooks";
import { completedAgentRun } from "@/chat/runtime/agent-run-outcome";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const slackWebhookClient = createSlackWebhookTestClient({
  signingSecret: SIGNING_SECRET,
});

function makeDiagnostics() {
  return {
    assistantMessageCount: 1,
    modelId: "fake-agent-model",
    outcome: "success" as const,
    toolCalls: [],
    toolErrorCount: 0,
    toolResultCount: 0,
    usedPrimaryText: true,
  };
}

function createEditedMentionRequest(args: {
  messageTs: string;
  newText: string;
  prevText: string;
}): Request {
  return slackWebhookClient.event({
    ...slackEventsApiEnvelope({
      eventType: "message",
      channel: "D12345",
      ts: args.messageTs,
      text: args.prevText,
    }),
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "D12345",
      hidden: true,
      message: {
        type: "message",
        user: "U123",
        text: args.newText,
        ts: args.messageTs,
      },
      previous_message: {
        type: "message",
        user: "U123",
        text: args.prevText,
        ts: args.messageTs,
      },
    },
  });
}

async function createEditedDmBot(args: {
  generateAssistantReply: ReplyExecutorServices["generateAssistantReply"];
}) {
  const state = createMemoryState();
  await state.connect();
  const bot = new JuniorChat<{ slack: SlackAdapter }>({
    userName: "junior",
    adapters: {
      slack: createJuniorSlackAdapter({
        botToken: "xoxb-test",
        botUserId: BOT_USER_ID,
        signingSecret: SIGNING_SECRET,
      }),
    },
    state,
  });
  const slackRuntime = createSlackRuntime({
    getSlackAdapter: () => bot.getAdapter("slack"),
    services: {
      replyExecutor: {
        generateAssistantReply: args.generateAssistantReply,
      },
    },
  });

  bot.onDirectMessage((thread, message) =>
    slackRuntime.handleNewMention(thread, message, {
      destination: createTestDestination(thread),
    }),
  );

  return bot;
}

describe("Slack contract: edited-message reply delivery", () => {
  it("posts the finalized reply into the edited DM thread with chat.postMessage", async () => {
    const bot = await createEditedDmBot({
      generateAssistantReply: async (_prompt, context) => {
        await context?.onTextDelta?.("Hello world");
        return completedAgentRun({
          text: "Hello world",
          diagnostics: makeDiagnostics(),
        });
      },
    });
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createEditedMentionRequest({
        messageTs: "1700000100.000100",
        newText: `<@${BOT_USER_ID}> hello there`,
        prevText: "hello there",
      }),
      "slack",
      waitUntil.fn,
      bot,
    );
    await waitUntil.flush();

    expect(response.status).toBe(200);
    expect(slackApiOutbox.messages()).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          blocks: [
            {
              type: "markdown",
              text: "Hello world",
            },
            {
              type: "context",
              elements: expect.arrayContaining([
                expect.objectContaining({
                  type: "mrkdwn",
                  text: expect.stringContaining(
                    "*ID:* slack:D12345:1700000100.000100",
                  ),
                }),
              ]),
            },
          ],
          channel: "D12345",
          thread_ts: "1700000100.000100",
          text: "Hello world",
        }),
      }),
    ]);
  });

  it("posts continuation messages with chat.postMessage when the final reply overflows", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const bot = await createEditedDmBot({
      generateAssistantReply: async () =>
        completedAgentRun({
          text: longReply,
          diagnostics: makeDiagnostics(),
        }),
    });
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createEditedMentionRequest({
        messageTs: "1700000100.000101",
        newText: `<@${BOT_USER_ID}> hello there`,
        prevText: "hello there",
      }),
      "slack",
      waitUntil.fn,
      bot,
    );
    await waitUntil.flush();

    expect(response.status).toBe(200);
    const postCalls = slackApiOutbox.messages();
    expect(postCalls.length).toBeGreaterThan(1);
    expect(postCalls[0]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "D12345",
          thread_ts: "1700000100.000101",
        }),
      }),
    );
  });
});
