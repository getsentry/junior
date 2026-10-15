import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { Message, type SerializedMessage } from "chat";
import { closeDb } from "@/chat/db";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { buildSlackUserInputMessage } from "@/chat/slack/user-input";
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
const QUESTION_TS = "1712345.0002";

function choiceClickPayload(args: {
  actionTs: string;
  userId: string;
}): Record<string, unknown> {
  const posted = buildSlackUserInputMessage({
    question: "Ship release 1.2.3?",
    options: [{ label: "Ship it" }, { label: "Hold" }],
  });
  return {
    type: "block_actions",
    team: { id: "T123" },
    user: { id: args.userId, team_id: "T123" },
    channel: { id: "C123" },
    message: {
      ts: QUESTION_TS,
      thread_ts: THREAD_TS,
      text: posted.text,
      blocks: posted.blocks,
    },
    actions: [
      {
        action_id: "junior_user_input:0",
        action_ts: args.actionTs,
        block_id: "junior_user_input",
        text: { type: "plain_text", text: "Ship it" },
        type: "button",
        value: "Ship it",
      },
    ],
  };
}

describe("Slack webhook: user input clicks", () => {
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
            payload: JSON.stringify(choiceClickPayload({ actionTs, userId })),
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

  it("sends the first clicked choice as the answer and closes the question", async () => {
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
      input: { authorId: "U123", text: "Ship it" },
    });
    expect(queue.queuedMessages()).toHaveLength(1);
    // Every Slack timestamp reader resolves the question message.
    const saved = work?.messages[0]?.input.metadata as
      | { message?: SerializedMessage }
      | undefined;
    if (!saved?.message) throw new Error("missing saved Slack message");
    expect(getMessageTimestamp(Message.fromJSON(saved.message))).toBe(
      QUESTION_TS,
    );

    // The processing reaction marks the question message, not a missing one.
    expect(slackApiOutbox.reactionAdds()[0]?.params).toMatchObject({
      channel: "C123",
      timestamp: QUESTION_TS,
    });

    const updates = slackApiOutbox.calls("chat.update");
    expect(updates).toHaveLength(1);
    const blocks = updates[0]?.params.blocks;
    const parsedBlocks: unknown[] =
      typeof blocks === "string" ? JSON.parse(blocks) : (blocks as unknown[]);
    expect(parsedBlocks).toEqual([
      { type: "markdown", text: "Ship release 1.2.3?" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "<@U123> chose *Ship it*" }],
      },
    ]);
    expect(updates[0]?.params).toMatchObject({
      channel: "C123",
      ts: QUESTION_TS,
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
    // second Turn for the same question.
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.authorId).toBe("U123");
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(1);
  });
});
