import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  SLACK_BOT_USER_ID,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackEnvelope,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

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
});
