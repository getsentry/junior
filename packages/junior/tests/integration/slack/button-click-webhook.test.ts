import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Message, type SerializedMessage } from "chat";
import { closeDb } from "@/chat/db";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { buildSlackButtonMessage } from "@/chat/slack/buttons";
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import {
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";

const ORIGINAL_ENV = { ...process.env };
const THREAD_TS = "1712345.0001";
const BUTTON_MESSAGE_TS = "1712345.0002";

function buttonClickPayload(args: {
  actionTs: string;
  userId: string;
}): Record<string, unknown> {
  const posted = buildSlackButtonMessage({
    text: "Ship this release?",
    buttons: [
      { label: "Ship it", value: "ship release 1.2.3", style: "primary" },
      { label: "Hold", value: "hold release 1.2.3" },
    ],
  });
  return {
    type: "block_actions",
    team: { id: "T123" },
    user: { id: args.userId, team_id: "T123" },
    channel: { id: "C123" },
    message: {
      ts: BUTTON_MESSAGE_TS,
      thread_ts: THREAD_TS,
      text: posted.text,
      blocks: posted.blocks,
    },
    actions: [
      {
        action_id: "junior_button:0",
        action_ts: args.actionTs,
        block_id: "junior_buttons",
        text: { type: "plain_text", text: "Ship it" },
        type: "button",
        value: "ship release 1.2.3",
      },
    ],
  };
}

describe("Slack webhook: Junior button clicks", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: "xoxb-test-token" };
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    await disconnectStateAdapter();
    await closeDb();
  });

  function clickHarness() {
    const state = createMemoryState();
    const queue = createConversationWorkQueueTestAdapter();
    const slackAdapter = createSlackAdapterFixture();
    const client = createSlackWebhookTestClient({
      signingSecret: SLACK_SIGNING_SECRET,
    });

    async function click(userId: string, actionTs: string) {
      const waitUntil = client.waitUntil();
      const response = await handleSlackWebhook({
        request: client.form(
          new URLSearchParams({
            payload: JSON.stringify(buttonClickPayload({ actionTs, userId })),
          }),
        ),
        waitUntil: waitUntil.fn,
        services: {
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
          state,
        },
      });
      expect(response.status).toBe(200);
      await waitUntil.flush();
    }

    return { click, queue, state };
  }

  it("starts one turn from the first click and answers the button message", async () => {
    const { click, queue, state } = clickHarness();

    await click("U123", "1712345.0003");
    await click("U456", "1712345.0004");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]).toMatchObject({
      delivery: "interrupt",
      input: {
        authorId: "U123",
        text: expect.stringContaining("Button label: Ship it"),
      },
    });
    expect(work?.messages[0]?.input.text).toContain(
      "Button value: ship release 1.2.3",
    );
    expect(queue.queuedMessages()).toHaveLength(1);
    // Every Slack timestamp reader resolves the button message.
    const saved = work?.messages[0]?.input.metadata as
      | { message?: SerializedMessage }
      | undefined;
    if (!saved?.message) throw new Error("missing saved Slack message");
    expect(getMessageTimestamp(Message.fromJSON(saved.message))).toBe(
      BUTTON_MESSAGE_TS,
    );

    // The processing reaction marks the button message, not a missing one.
    expect(slackApiOutbox.reactionAdds()[0]?.params).toMatchObject({
      channel: "C123",
      timestamp: BUTTON_MESSAGE_TS,
    });

    const updates = slackApiOutbox.calls("chat.update");
    expect(updates).toHaveLength(1);
    const blocks = updates[0]?.params.blocks;
    const parsedBlocks: unknown[] =
      typeof blocks === "string" ? JSON.parse(blocks) : (blocks as unknown[]);
    expect(parsedBlocks).toEqual([
      { type: "markdown", text: "Ship this release?" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "<@U123> chose *Ship it*" }],
      },
    ]);
    expect(updates[0]?.params).toMatchObject({
      channel: "C123",
      ts: BUTTON_MESSAGE_TS,
    });
  });

  it("keeps the first click when only the queue wake fails", async () => {
    const { click, queue, state } = clickHarness();
    queue.rejectSends();

    await click("U123", "1712345.0003");
    await click("U456", "1712345.0004");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    // Heartbeat recovery runs the saved click. A later click must not add a
    // second Turn for the same button message.
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.authorId).toBe("U123");
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(1);
  });
});
