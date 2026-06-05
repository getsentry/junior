import type { Message, Thread } from "chat";
import { getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_ID,
  conversationQueueMessage,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  processNextQueuedSlackWork,
  SLACK_BOT_USER_ID,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { useMemoryStateAdapter } from "../../fixtures/vitest";

describe("Slack conversation work ingress", () => {
  useMemoryStateAdapter();

  it("persists Slack mentions into the durable mailbox and wakes the queue", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest(
        slackEnvelope({
          text: `<@${SLACK_BOT_USER_ID}> deploy status`,
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
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
      }),
    ]);
    expect(queue.queuedMessages()).toEqual([
      conversationQueueMessage(),
    ]);
    const work = await getConversationWorkState({
      conversationId: CONVERSATION_ID,
      state,
    });
    expect(work?.needsRun).toBe(true);
    expect(work?.messages).toEqual([
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        source: "slack",
        input: expect.objectContaining({
          authorId: "U123",
          metadata: expect.objectContaining({
            platform: "slack",
            route: "mention",
          }),
        }),
      }),
    ]);
  });

  it("does not persist Slack mailbox messages without actor ids", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "app_mention",
          text: `<@${SLACK_BOT_USER_ID}> missing actor`,
          channel: "C123",
          ts: "1712345.0099",
          event_ts: "1712345.0099",
          channel_type: "channel",
        },
      }),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);
    await expect(
      getConversationWorkState({ conversationId: CONVERSATION_ID, state }),
    ).resolves.toBeUndefined();
  });

  it("routes edited Slack mentions through the durable mailbox", async () => {
    const queue = createConversationWorkQueueTestAdapter();
    const state = getStateAdapter();
    await state.connect();
    const slackAdapter = createSlackAdapterFixture();
    const editedTs = "1712345.0003";
    const editedText = `<@${SLACK_BOT_USER_ID}> edited ask`;

    const response = await handleSlackWebhookAndFlush({
      request: slackWebhookRequest({
        ...slackEnvelope({
          eventType: "message",
          text: "edited ask",
          ts: editedTs,
        }),
        event: {
          type: "message",
          subtype: "message_changed",
          channel: "C123",
          hidden: true,
          message: {
            type: "message",
            user: "U123",
            text: editedText,
            ts: editedTs,
          },
          previous_message: {
            type: "message",
            user: "U123",
            text: "edited ask",
            ts: editedTs,
          },
        },
      }),
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: `slack:C123:${editedTs}`,
        idempotencyKey: `slack:T123:slack:C123:${editedTs}:${editedTs}:message_changed_mention`,
      }),
    ]);

    const calls: Array<{ message: Message; thread: Thread }> = [];
    await expect(
      processNextQueuedSlackWork({
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: {
          handleNewMention: async (thread, message, hooks) => {
            await hooks?.onInputCommitted?.();
            calls.push({ thread, message });
          },
          handleSubscribedMessage: async () => {
            throw new Error("unexpected subscribed route");
          },
        },
        state,
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.thread.id).toBe(`slack:C123:${editedTs}`);
    expect(calls[0]?.message.id).toBe(`${editedTs}:message_changed_mention`);
    expect(calls[0]?.message.text).toBe(editedText);
    expect(calls[0]?.message.isMention).toBe(true);
  });
});
