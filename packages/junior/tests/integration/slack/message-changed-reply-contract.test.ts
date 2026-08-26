import { createTestDestination } from "../../fixtures/slack-harness";
import { describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { SlackAdapter } from "@chat-adapter/slack";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { createSlackRuntime } from "@/chat/app/factory";
import { JuniorChat } from "@/chat/ingress/junior-chat";
import type { AgentRunner } from "@/chat/runtime/agent-runner";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import { handleChatSdkPlatformWebhook } from "@/handlers/webhooks";
import { createModelAgentRunner } from "../../fixtures/agent-runner";
import { createModelStream } from "../../fixtures/model-stream";
import { queueSlackApiError } from "../../msw/handlers/slack-api";
import {
  getPausedTurnRequest,
  wakePausedTurn as schedulePausedTurnWake,
} from "@/chat/task-execution/turn-wake";
import { buildDeterministicTurnId } from "@/chat/runtime/turn";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../../fixtures/conversation-work";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT";
const slackWebhookClient = createSlackWebhookTestClient({
  signingSecret: SIGNING_SECRET,
});

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
  agentRunner: AgentRunner;
  queue?: ConversationWorkQueueTestAdapter;
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
      agentRunner: args.agentRunner,
      replyExecutor: {
        ...(args.queue
          ? {
              wakePausedTurn: async (request) => {
                await schedulePausedTurnWake(request, {
                  queue: args.queue,
                  state,
                });
              },
            }
          : undefined),
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
      agentRunner: createModelAgentRunner(
        createModelStream([{ type: "text", text: "Hello world" }]),
      ),
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
          channel: "D12345",
          thread_ts: "1700000100.000100",
          text: "Hello world",
        }),
      }),
    ]);
  });

  it("posts continuation messages with chat.postMessage when a completed message overflows", async () => {
    const longReply = Array.from(
      { length: 80 },
      (_, i) => `line ${i + 1}`,
    ).join("\n");
    const bot = await createEditedDmBot({
      agentRunner: createModelAgentRunner(
        createModelStream([{ type: "text", text: longReply }]),
      ),
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

  it("wakes a suspended turn with its Slack destination after a transient delivery failure", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      queueSlackApiError("chat.postMessage", {
        error: "internal_error",
        status: 503,
      });
    }
    const queue = createConversationWorkQueueTestAdapter();
    const bot = await createEditedDmBot({
      agentRunner: createModelAgentRunner(
        createModelStream([{ type: "text", text: "Hello world" }]),
      ),
      queue,
    });
    const waitUntil = slackWebhookClient.waitUntil();

    const response = await handleChatSdkPlatformWebhook(
      createEditedMentionRequest({
        messageTs: "1700000100.000102",
        newText: `<@${BOT_USER_ID}> hello there`,
        prevText: "hello there",
      }),
      "slack",
      waitUntil.fn,
      bot,
    );
    await waitUntil.flush();

    expect(response.status).toBe(200);
    const conversationId = "slack:D12345:1700000100.000102";
    const turnId = buildDeterministicTurnId(
      "1700000100.000102:message_changed_mention",
    );
    await expect(
      getPausedTurnRequest({ conversationId, turnId }),
    ).resolves.toMatchObject({
      conversationId,
      destination: {
        platform: "slack",
        teamId: "TTEST",
        channelId: "D12345",
      },
      expectedVersion: 2,
      turnId,
    });
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId,
        idempotencyKey: expect.stringContaining(
          `agent-continue:${conversationId}:${turnId}:2:`,
        ),
      }),
    ]);
  });
});
