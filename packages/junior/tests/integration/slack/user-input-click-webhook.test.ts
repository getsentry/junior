import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { Message, type SerializedMessage } from "chat";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { closeDb, getConversationStore } from "@/chat/db";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { recordOpenSlackUserInput } from "@/chat/slack/user-input-state";
import type { UserInputRequest } from "@/chat/tools/runtime/user-input-request";
import { getMessageTimestamp } from "@/chat/slack/message/identity";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import {
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { usersInfoOk } from "../../fixtures/slack/factories/api";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const ORIGINAL_ENV = { ...process.env };
const THREAD_TS = "1712345.0001";
const QUESTION_TS = "1712345.0002";

const REQUEST_ID = "toolu_ship";

const QUESTION: UserInputRequest = {
  question: "Ship release 1.2.3?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Ship it" }, { label: "Hold" }],
    },
  ],
};

const FORM_QUESTION: UserInputRequest = {
  question: "How should I fix the merge conflict?",
  fields: [
    {
      id: "approach",
      kind: "choice",
      label: "Approach",
      options: [{ label: "Rebase" }, { label: "Merge" }],
    },
    {
      id: "checks",
      kind: "multi_choice",
      label: "Checks",
      options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }],
    },
  ],
};

function blockActionPayload(args: {
  action: Record<string, unknown>;
  userId: string;
}): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: "T123" },
    trigger_id: "trigger-1",
    user: { id: args.userId, team_id: "T123" },
    channel: { id: "C123" },
    message: { ts: QUESTION_TS, thread_ts: THREAD_TS },
    actions: [
      { block_id: "junior_user_input", type: "button", ...args.action },
    ],
  };
}

function choiceClickPayload(args: {
  actionTs: string;
  userId: string;
}): Record<string, unknown> {
  return blockActionPayload({
    action: {
      action_id: "junior_user_input:choice:0",
      action_ts: args.actionTs,
      value: "Ship it",
    },
    userId: args.userId,
  });
}

function parsedUpdateBlocks(index = 0): unknown[] {
  const blocks = slackApiOutbox.calls("chat.update")[index]?.params.blocks;
  return typeof blocks === "string"
    ? JSON.parse(blocks)
    : (blocks as unknown[]);
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

  function clickHarness(options: { allowedDomains?: string[] } = {}) {
    // Dashboard messages use the default state adapter, so clicks do too.
    const state = getStateAdapter();
    const queue = createConversationWorkQueueTestAdapter();
    const slackAdapter = createSlackAdapterFixture();
    const client = createSlackWebhookTestClient({
      signingSecret: SLACK_SIGNING_SECRET,
    });

    async function interact(payload: Record<string, unknown>) {
      const waitUntil = client.waitUntil();
      const response = await handleSlackWebhook({
        request: client.form(
          new URLSearchParams({ payload: JSON.stringify(payload) }),
        ),
        waitUntil: waitUntil.fn,
        services: {
          allowedDomains: options.allowedDomains,
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
          state,
        },
      });
      expect(response.status).toBe(200);
      await waitUntil.flush();
    }

    const click = (userId: string, actionTs: string) =>
      interact(choiceClickPayload({ actionTs, userId }));

    async function reply(userId: string, ts: string, status = 200) {
      const waitUntil = client.waitUntil();
      const response = await handleSlackWebhook({
        request: client.event(
          slackEventsApiEnvelope({
            eventType: "app_mention",
            channel: "C123",
            text: `<@${SLACK_BOT_USER_ID}> Hold, the tests are red`,
            threadTs: THREAD_TS,
            ts,
            user: userId,
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
      expect(response.status).toBe(status);
      await waitUntil.flush();
    }

    async function recordQuestion(request: UserInputRequest = QUESTION) {
      // requestUserInput records the question when it posts it in Slack.
      await state.connect();
      await recordOpenSlackUserInput(state, {
        channelId: "C123",
        messageTs: QUESTION_TS,
        request,
        requestId: REQUEST_ID,
        threadTs: THREAD_TS,
      });
    }

    async function answerInDashboard(email: string, status = 200) {
      const conversationId = `slack:C123:${THREAD_TS}`;
      await getConversationStore().recordActivity({
        actor: {
          email,
          platform: "slack",
          slackUserId: "U789",
          teamId: "T123",
        },
        conversationId,
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
          threadTs: THREAD_TS,
        },
        nowMs: 1,
        source: "slack",
        title: "Release thread",
        visibility: "private",
      });
      const app = new Hono<JuniorApiEnv>();
      app.use("*", async (context, next) => {
        context.set("viewer", testViewer(email));
        await next();
      });
      app.route(
        "/api/conversations",
        createConversationRoutes({
          attachmentStorage: createMemoryAttachmentStorage(),
          queue,
        }),
      );
      const response = await app.request(
        `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: "dashboard-answer",
            message: `Answer to request ${REQUEST_ID}:\nDecision (decision): Hold`,
          }),
        },
      );
      expect(response.status).toBe(status);
    }

    return {
      answerInDashboard,
      click,
      interact,
      queue,
      recordQuestion,
      reply,
      state,
    };
  }

  it("sends the first clicked choice as the answer and closes the question", async () => {
    const { click, queue, recordQuestion, state } = clickHarness();
    await recordQuestion();

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
        text: `Answer to request ${REQUEST_ID}:\nDecision (decision): Ship it`,
      },
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
    expect(parsedUpdateBlocks()).toEqual([
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

  it("ignores a click from a person outside the allowed domains", async () => {
    const { click, queue, recordQuestion, state } = clickHarness({
      allowedDomains: ["example.com"],
    });
    const emails: Record<string, string> = {
      U123: "someone@contractor.dev",
      U456: "testuser@example.com",
    };
    mswServer.use(
      http.post("https://slack.com/api/users.info", async ({ request }) => {
        const user = new URLSearchParams(await request.text()).get("user")!;
        return HttpResponse.json(
          usersInfoOk({ userId: user, email: emails[user] }),
        );
      }),
    );
    await recordQuestion();

    // The rejected click must not claim the question.
    await click("U123", "1712345.0003");
    expect(queue.queuedMessages()).toHaveLength(0);
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(0);

    await click("U456", "1712345.0004");
    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.authorId).toBe("U456");
    expect(queue.queuedMessages()).toHaveLength(1);
  });

  it("keeps the first click when only the queue wake fails", async () => {
    const { click, queue, recordQuestion, state } = clickHarness();
    await recordQuestion();
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

  it("closes the question when a person replies to Junior instead", async () => {
    const { click, recordQuestion, reply, state } = clickHarness();
    await recordQuestion();

    await reply("U456", "1712345.0003");
    await click("U123", "1712345.0004");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    // The typed reply is the answer. The later click must not add a Turn.
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.authorId).toBe("U456");
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(1);
    expect(parsedUpdateBlocks()).toEqual([
      { type: "markdown", text: "Ship release 1.2.3?" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "<@U456> replied in the thread" }],
      },
    ]);
  });

  it("keeps a typed reply as the answer when only the queue wake fails", async () => {
    const { click, queue, recordQuestion, reply, state } = clickHarness();
    await recordQuestion();
    queue.rejectSends();

    // Slack retries the event, but the mailbox already saved the reply.
    await reply("U456", "1712345.0003", 503);
    await click("U123", "1712345.0004");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.authorId).toBe("U456");
    const updates = slackApiOutbox.calls("chat.update");
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0]?.params.blocks)).toContain(
      "<@U456> replied in the thread",
    );
  });

  it("closes the Slack question when a person answers in the dashboard", async () => {
    const { answerInDashboard, click, recordQuestion, state } = clickHarness();
    await recordQuestion();

    await answerInDashboard("participant@example.com");
    await click("U123", "1712345.0004");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    // The dashboard answer wins. The later click must not add a Turn.
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.text).toContain(
      "Decision (decision): Hold",
    );
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(1);
    expect(parsedUpdateBlocks()).toEqual([
      { type: "markdown", text: "Ship release 1.2.3?" },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "participant@example.com answered in the Junior dashboard",
          },
        ],
      },
    ]);
  });

  it("keeps a dashboard answer when only the queue wake fails", async () => {
    const { answerInDashboard, click, queue, recordQuestion, state } =
      clickHarness();
    await recordQuestion();
    queue.rejectSends();

    // The dashboard shows an error, but the mailbox already saved the answer.
    await answerInDashboard("participant@example.com", 500);
    await click("U123", "1712345.0004");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input.text).toContain(
      "Decision (decision): Hold",
    );
    expect(JSON.stringify(parsedUpdateBlocks())).toContain(
      "answered in the Junior dashboard",
    );
  });

  it("answers a form request with the submitted values", async () => {
    const { interact, recordQuestion, state } = clickHarness();
    await recordQuestion(FORM_QUESTION);

    await interact(
      blockActionPayload({
        action: {
          action_id: "junior_user_input:open",
          action_ts: "1712345.0003",
        },
        userId: "U123",
      }),
    );
    const opened = slackApiOutbox.calls("views.open");
    expect(opened).toHaveLength(1);
    const view = opened[0]?.params.view;
    const modal = (typeof view === "string" ? JSON.parse(view) : view) as {
      blocks: Array<{ block_id: string }>;
      private_metadata: string;
    };
    expect(modal.blocks.map((block) => block.block_id)).toEqual([
      "field:approach",
      "field:checks",
      "other",
    ]);

    const submit = (userId: string, viewId: string) =>
      interact({
        type: "view_submission",
        team: { id: "T123" },
        user: { id: userId, team_id: "T123" },
        view: {
          id: viewId,
          callback_id: "junior_user_input",
          private_metadata: modal.private_metadata,
          state: {
            values: {
              "field:approach": {
                value: { selected_option: { value: "Rebase" } },
              },
              "field:checks": {
                value: {
                  selected_options: [{ value: "Tests" }, { value: "Lint" }],
                },
              },
              other: { value: { value: "Keep the commit history." } },
            },
          },
        },
      });
    await submit("U123", "V1");
    await submit("U456", "V2");

    const work = await getConversationWorkState({
      conversationId: `slack:C123:${THREAD_TS}`,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input).toMatchObject({
      authorId: "U123",
      text: [
        `Answer to request ${REQUEST_ID}:`,
        "Approach (approach): Rebase",
        "Checks (checks): Lint, Tests",
        "Other: Keep the commit history.",
      ].join("\n"),
    });
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(1);
    expect(parsedUpdateBlocks().at(-1)).toEqual({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "<@U123> answered\n*Approach*: Rebase\n*Checks*: Lint, Tests\n*Other*: Keep the commit history.",
        },
      ],
    });
  });
});
