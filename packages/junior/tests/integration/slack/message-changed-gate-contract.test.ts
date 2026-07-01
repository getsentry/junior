import { afterEach, describe, expect, it } from "vitest";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import {
  SLACK_BOT_USER_ID,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
  handleSlackWebhookAndFlush,
  slackWebhookRequest,
} from "../../fixtures/conversation-work";

const EDITED_TS = "1712345.0042";

function messageChangedEnvelope(message: {
  bot_id?: string;
  user: string;
  user_team?: string;
}) {
  const editedText = `<@${SLACK_BOT_USER_ID}> edited ask`;
  return {
    team_id: "T123",
    type: "event_callback",
    event: {
      type: "message",
      subtype: "message_changed",
      channel: "C123",
      hidden: true,
      message: {
        type: "message",
        text: editedText,
        ts: EDITED_TS,
        ...message,
      },
      previous_message: {
        type: "message",
        user: message.user,
        text: "edited ask",
        ts: EDITED_TS,
      },
    },
  };
}

describe("Slack message_changed author gate contract", () => {
  afterEach(async () => {
    await disconnectStateAdapter();
  });

  async function runEditedMentionWebhook(envelope: unknown) {
    const queue = createConversationWorkQueueTestAdapter();
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
    return { queue, response };
  }

  it("drops an edited mention from a Slack Connect external user", async () => {
    const { queue, response } = await runEditedMentionWebhook(
      messageChangedEnvelope({ user: "U_EXTERNAL", user_team: "T_OTHER_ORG" }),
    );

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);
  });

  it("drops a bot-authored edit that adds a mention", async () => {
    const { queue, response } = await runEditedMentionWebhook(
      messageChangedEnvelope({ bot_id: "B_JUNIOR", user: SLACK_BOT_USER_ID }),
    );

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);
  });

  it("routes an edited mention from a same-workspace user", async () => {
    const { queue, response } = await runEditedMentionWebhook(
      messageChangedEnvelope({ user: "U123", user_team: "T123" }),
    );

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({
        conversationId: `slack:C123:${EDITED_TS}`,
      }),
    ]);
  });
});
