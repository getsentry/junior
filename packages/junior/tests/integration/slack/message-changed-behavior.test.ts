import { createMemoryState } from "@chat-adapter/state-memory";
import { describe, expect, it } from "vitest";
import { getConversationWorkState } from "@/chat/task-execution/store";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";

describe("Slack behavior: message_changed webhook ingress", () => {
  it("ignores an edit that adds a Junior mention", async () => {
    const state = createMemoryState();
    await state.connect();
    const adapter = createSlackAdapterFixture();
    const queue = createConversationWorkQueueTestAdapter();
    const services = {
      getSlackAdapter: () => adapter,
      queue,
      runtime: createNoopSlackWebhookRuntime(),
      state,
    };
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
        channel_type: "im",
        hidden: true,
        ts: "1700000200.000200",
        event_ts: "1700000200.000200",
        message: {
          type: "message",
          user: original.event.user,
          text: `<@${adapter.botUserId}> hello there`,
          ts: "1700000100.000100",
        },
        previous_message: {
          type: "message",
          user: original.event.user,
          text: "hello there",
          ts: "1700000100.000100",
        },
      },
    };

    for (const body of [original, edit]) {
      const response = await handleSlackWebhookAndFlush({
        request: slackWebhookRequest(body),
        services,
      });
      expect(response.status).toBe(200);
    }

    expect(queue.queuedMessages()).toHaveLength(1);
    const work = await getConversationWorkState({
      conversationId: "slack:D12345:1700000100.000100",
      state,
    });
    expect(work?.messages.map((message) => message.input.text)).toEqual([
      "hello there",
    ]);
    await state.disconnect();
  });
});
