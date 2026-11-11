import type { Identity, User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { actOnReviewItem } from "@/chat/review-items/actions";
import {
  closeReviewItem,
  getReviewItem,
  REVIEW_ITEM_REPLIED_REASON,
} from "@/chat/review-items/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createSlackReviewItemShow } from "@/chat/slack/review-item-card-sync";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { createAddReviewItemTool } from "@/chat/tools/review-items";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import { mswServer } from "../../msw/server";
import {
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { linkSlackUser } from "../../fixtures/slack-user";
import { usersInfoOk } from "../../fixtures/slack/factories/api";
import { slackEventsApiEnvelope } from "../../fixtures/slack/factories/events";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";

const ORIGINAL_ENV = { ...process.env };
const THREAD = "slack:C123:1712345.0001";
const OTHER_THREAD = "slack:C456:1712345.0009";
// The Slack API mock gives every posted message this ts.
const CARD_TS = "1700000000.100";

const SHIP_REQUEST = {
  question: "Ship release 1.2.3?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Ship it", recommended: true }, { label: "Hold" }],
    },
  ],
};

async function slackThread(
  conversationId: string,
  visibility: "public" | "private",
): Promise<void> {
  const [, channelId, threadTs] = conversationId.split(":");
  await getConversationStore().recordActivity({
    // Ana takes part, so her agent can link the thread.
    actor: {
      email: "ana@example.com",
      platform: "slack",
      slackUserId: "U123",
      teamId: "T123",
    },
    conversationId,
    destination: {
      channelId: channelId!,
      platform: "slack",
      teamId: "T123",
      threadTs: threadTs!,
    },
    nowMs: 1,
    source: "slack",
    visibility,
  });
}

async function addItem(
  user: User,
  input: Record<string, unknown>,
  conversationId = THREAD,
) {
  const tool = createAddReviewItemTool(
    {
      conversationId,
      resolveActorIdentity: async () => ({
        identity: { id: `identity:${user.id}` } as Identity,
        user,
      }),
      source: { kind: "slack" } as any,
    },
    createSlackReviewItemToolServices(createConversationWorkQueueTestAdapter),
  );
  return (await (tool as any).execute(input, {})) as {
    item: { assignees: string[]; id: string };
  };
}

function blocksOf(call: { params: Record<string, unknown> } | undefined) {
  const blocks = call?.params.blocks;
  return (typeof blocks === "string" ? JSON.parse(blocks) : blocks) as Array<{
    elements?: Array<{
      action_id?: string;
      style?: string;
      text?: unknown;
      value?: string;
    }>;
    text?: string;
    type: string;
  }>;
}

/** The value of one button on a posted card, as Slack sends it back. */
function buttonValue(
  call: { params: Record<string, unknown> } | undefined,
  actionId: string,
): string {
  const value = blocksOf(call)
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === actionId)?.value;
  if (!value) throw new Error(`no button ${actionId}`);
  return value;
}

describe("Slack webhook: Review item cards", () => {
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

  function harness(options: { allowedDomains?: string[] } = {}) {
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
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
          state,
        },
      });
      expect(response.status).toBe(200);
      await waitUntil.flush();
    }
    const click = (args: {
      actionId: string;
      actionTs: string;
      itemId: string;
      userId: string;
      value?: string;
    }) =>
      interact({
        type: "block_actions",
        team: { id: "T123" },
        trigger_id: "trigger-1",
        user: { id: args.userId, team_id: "T123" },
        channel: { id: "C123" },
        message: { ts: CARD_TS, thread_ts: "1712345.0001" },
        actions: [
          {
            action_id: args.actionId,
            action_ts: args.actionTs,
            type: "button",
            value: args.value ?? args.itemId,
          },
        ],
      });
    /**
     * A message from a person in the card thread. Without a mention, it is a
     * reply in a thread that Junior follows.
     */
    async function reply(userId: string, ts: string, { mention = true } = {}) {
      const waitUntil = client.waitUntil();
      const response = await handleSlackWebhook({
        request: client.event({
          ...slackEventsApiEnvelope({
            eventType: mention ? "app_mention" : "message",
            channel: "C123",
            text: mention
              ? `<@${SLACK_BOT_USER_ID}> Hold, the tests are red`
              : "Hold, the tests are red",
            threadTs: "1712345.0001",
            ts,
            user: userId,
          }),
          event_id: `Ev_${ts}`,
        }),
        waitUntil: waitUntil.fn,
        services: {
          ...options,
          getSlackAdapter: () => slackAdapter,
          queue,
          runtime: createNoopSlackWebhookRuntime(),
          state,
        },
      });
      expect(response.status).toBe(200);
      await waitUntil.flush();
    }
    /** A message from a person to the Conversation on the dashboard. */
    async function postInDashboard(viewer: User) {
      const app = new Hono<JuniorApiEnv>();
      app.use("*", async (context, next) => {
        context.set("viewer", viewer);
        await next();
      });
      app.route(
        "/api/conversations",
        createConversationRoutes({
          attachmentStorage: createMemoryAttachmentStorage(),
          queue,
        }),
      );
      return await app.request(
        `http://localhost/api/conversations/${encodeURIComponent(THREAD)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            idempotencyKey: "dashboard-reply",
            message: "Hold, the tests are red.",
          }),
        },
      );
    }
    return { click, interact, postInDashboard, queue, reply, state };
  }

  it("closes an item everywhere on the first click in a Slack card", async () => {
    const { click, state } = harness();
    await slackThread(THREAD, "public");
    await slackThread(OTHER_THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await linkSlackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      kind: "action",
      title: "Ship release 1.2.3",
      body: "The release checks passed.",
      assignees: ["everyone"],
      dedupe_key: "release:1.2.3",
      request: SHIP_REQUEST,
      conversation_ids: [OTHER_THREAD],
    });

    // Each linked thread gets a card with one button per choice. The
    // recommended choice is the primary button.
    const posts = slackApiOutbox.messages();
    expect(posts.map((post) => post.params.channel).sort()).toEqual([
      "C123",
      "C456",
    ]);
    const controls = blocksOf(posts[0]).find(
      (block) => block.type === "actions",
    );
    expect(
      controls?.elements?.map((element) => [element.action_id, element.style]),
    ).toEqual([
      ["junior_review_item:choice:0", "primary"],
      ["junior_review_item:choice:1", undefined],
      ["junior_review_item:answer", undefined],
      ["junior_review_item:dismiss", undefined],
    ]);

    // The agent changes the choices. A click on the old card cannot pick a
    // choice that the item no longer offers.
    const shipIt = buttonValue(posts[0], "junior_review_item:choice:0");
    const changeChoices = (options: Array<{ label: string }>) =>
      addItem(ana, {
        kind: "action",
        title: "Ship release 1.2.3",
        body: "The release checks passed.",
        assignees: ["everyone"],
        dedupe_key: "release:1.2.3",
        request: {
          ...SHIP_REQUEST,
          fields: [{ ...SHIP_REQUEST.fields[0]!, options }],
        },
      });
    await changeChoices([{ label: "Hold" }, { label: "Wait" }]);
    await click({
      actionId: "junior_review_item:choice:0",
      actionTs: "1712345.0002",
      itemId: item.id,
      userId: "U123",
      value: shipIt,
    });
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params).toMatchObject(
      { text: "This card changed. Use the updated card.", user: "U123" },
    );
    // A stale button picks the label that it shows, not the new choice in
    // its place.
    await changeChoices([{ label: "Hold" }, { label: "Ship it" }]);
    const updatesBeforeClose = slackApiOutbox.calls("chat.update").length;

    // Two fast clicks both see an open item, but only one adds a Turn.
    await Promise.all([
      click({
        actionId: "junior_review_item:choice:0",
        actionTs: "1712345.0003",
        itemId: item.id,
        userId: "U123",
        value: shipIt,
      }),
      click({
        actionId: "junior_review_item:choice:0",
        actionTs: "1712345.0005",
        itemId: item.id,
        userId: "U123",
        value: shipIt,
      }),
    ]);
    // A second click on a stale card does not add a second Turn.
    await click({
      actionId: "junior_review_item:choice:1",
      actionTs: "1712345.0004",
      itemId: item.id,
      userId: "U456",
      value: buttonValue(posts[0], "junior_review_item:choice:1"),
    });

    // The thread of the card gets the answer as Slack input from the person.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input).toMatchObject({ authorId: "U123" });
    expect(work?.messages[0]?.input.text).toContain(
      `answered review item "Ship release 1.2.3" (${item.id})`,
    );
    expect(work?.messages[0]?.input.text).toContain(
      "Decision (decision): Ship it",
    );
    // The input records the answer, so its saved Message shows as one.
    expect(work?.messages[0]?.input.reviewItemChange).toEqual({
      kind: "submitted",
      reviewItemId: item.id,
    });
    // The other linked thread learns about it once, from the person.
    const other = await getConversationWorkState({
      conversationId: OTHER_THREAD,
      state,
    });
    expect(other?.messages).toHaveLength(1);
    expect(other?.messages[0]?.input.text).toContain("answered review item");
    expect(other?.messages[0]?.input.reviewItemChange).toEqual({
      kind: "submitted",
      reviewItemId: item.id,
    });

    // Both cards lose their controls and show the answer.
    const updates = slackApiOutbox
      .calls("chat.update")
      .slice(updatesBeforeClose);
    expect(updates.slice(0, 2).map((update) => update.params.channel)).toEqual(
      expect.arrayContaining(["C123", "C456"]),
    );
    for (const update of updates) {
      const blocks = blocksOf(update);
      expect(blocks.some((block) => block.type === "actions")).toBe(false);
      expect(JSON.stringify(blocks)).toContain(
        "ana@example.com chose *Ship it*",
      );
    }
    expect(
      slackApiOutbox.calls("chat.postEphemeral").map((call) => call.params),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Review item is closed.",
          user: "U123",
        }),
        expect.objectContaining({
          text: "Review item is closed.",
          user: "U456",
        }),
      ]),
    );
  });

  it("records a click in the Automation run that owns the card thread", async () => {
    const { click, state } = harness();
    // An Automation run owns this Slack thread under its own id.
    const run = "scheduled-automation:auto-1:run-1";
    await getConversationStore().recordActivity({
      conversationId: run,
      destination: {
        channelId: "C123",
        platform: "slack",
        teamId: "T123",
        threadTs: "1712345.0001",
      },
      nowMs: 1,
      source: "slack",
      visibility: "public",
    });
    await getConversationStore().bindProviderConversation({
      conversationId: run,
      provider: "slack",
      providerConversationId: "1712345.0001",
      providerDestinationId: "C123",
      providerTenantId: "T123",
    });
    const ana = await linkSlackUser("ana@example.com", "U123");
    const { item } = await addItem(
      ana,
      {
        kind: "action",
        title: "Ship release 1.2.3",
        body: "The release checks passed.",
        assignees: ["ana@example.com"],
        dedupe_key: "release:1.2.3",
        request: SHIP_REQUEST,
      },
      run,
    );
    const [card] = slackApiOutbox.messages();
    expect(card?.params).toMatchObject({
      channel: "C123",
      thread_ts: "1712345.0001",
    });

    await click({
      actionId: "junior_review_item:choice:0",
      actionTs: "1712345.0003",
      itemId: item.id,
      userId: "U123",
      value: buttonValue(card, "junior_review_item:choice:0"),
    });

    // The run gets the answer once, as Slack input from Ana, not as a
    // relayed event.
    const work = await getConversationWorkState({
      conversationId: run,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input).toMatchObject({ authorId: "U123" });
    expect(work?.messages[0]?.input.text).toContain(
      "Decision (decision): Ship it",
    );
  });

  it("names the recommended option of a form in the card text", async () => {
    harness();
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await addItem(ana, {
      kind: "action",
      title: "Plan the rollout",
      body: "Pick a rollout window.",
      assignees: ["everyone"],
      request: {
        question: "How should the rollout go?",
        fields: [
          {
            id: "window",
            kind: "choice",
            label: "Window",
            options: [
              { label: "Tuesday 02:00 UTC", recommended: true },
              { label: "Thursday 02:00 UTC" },
            ],
          },
          { id: "notes", kind: "text", label: "Notes" },
        ],
      },
    });

    const [post] = slackApiOutbox.messages();
    expect(JSON.stringify(blocksOf(post))).toContain(
      "Tuesday 02:00 UTC (suggested), Thursday 02:00 UTC",
    );
  });

  it("keeps a long answer inside the Slack limits of a card", async () => {
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      const { queue } = harness();
      await slackThread(THREAD, "public");
      const ana = await linkSlackUser("ana@example.com", "U123");
      const { item } = await addItem(ana, {
        kind: "action",
        title: "Review the release notes",
        body: "The notes need a look.",
        assignees: ["ana@example.com"],
        dedupe_key: "release-notes",
        request: {
          question: "What should change?",
          fields: [{ id: "notes", kind: "text", label: "Notes" }],
        },
      });

      await actOnReviewItem({
        action: "submit",
        answer: { requestId: item.id, values: { notes: ["x".repeat(3_000)] } },
        delivery: { queue, show: createSlackReviewItemShow() },
        id: item.id,
        user: ana,
      });

      // Slack rejects a context element over 3,000 characters, and then the
      // card keeps its controls.
      const [update] = slackApiOutbox.calls("chat.update");
      const context = blocksOf(update).find(
        (block) => block.type === "context",
      );
      const texts = (context?.elements ?? []).map(
        (element) => element.text as string,
      );
      expect(texts).toEqual([
        expect.stringContaining("ana@example.com answered"),
        expect.stringContaining("|Open in the review desk>"),
      ]);
      for (const text of texts) expect(text.length).toBeLessThanOrEqual(3_000);
    } finally {
      setDashboardConversationLinkOptions(undefined);
    }
  });

  it("lets only an assignee act on a private item card", async () => {
    const { click, state } = harness();
    await slackThread(THREAD, "private");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await linkSlackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      kind: "notice",
      title: "Rotate the deploy key",
      body: "The deploy key expires on Friday.",
      assignees: ["ana@example.com"],
      dedupe_key: "deploy-key",
      subject: {
        id: "acme/infra#12",
        url: "https://github.com/acme/infra/pull/12",
      },
    });

    const posts = slackApiOutbox.messages();
    expect(posts.map((post) => post.params.channel)).toEqual(["C123"]);
    // The title links to the subject.
    expect(blocksOf(posts[0])[0]?.text).toContain(
      "**[Rotate the deploy key](https://github.com/acme/infra/pull/12)**",
    );
    // A notice has nothing to answer, so its only control is Dismiss.
    expect(
      blocksOf(posts[0])
        .find((block) => block.type === "actions")
        ?.elements?.map((element) => element.action_id),
    ).toEqual(["junior_review_item:dismiss"]);

    // Only an assignee can act. Ben gets an ephemeral note.
    await click({
      actionId: "junior_review_item:dismiss",
      actionTs: "1712345.0003",
      itemId: item.id,
      userId: "U456",
    });
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params).toMatchObject(
      { text: "Review item not found.", user: "U456" },
    );

    await click({
      actionId: "junior_review_item:dismiss",
      actionTs: "1712345.0004",
      itemId: item.id,
      userId: "U123",
    });
    const updates = slackApiOutbox.calls("chat.update");
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(blocksOf(updates[0]))).toContain(
      "ana@example.com dismissed this",
    );
    // A dismiss starts no Turn. The thread saves it as a handled Message.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages ?? []).toEqual([]);
    const saved = projectConversationMessages(
      await getConversationEventStore().loadMessageHistory(THREAD),
    );
    expect(saved.map((message) => message.meta?.reviewItemChanges)).toEqual([
      [{ kind: "dismissed", reviewItemId: item.id }],
    ]);
  });

  // Which open question a reply answers is a decision model choice, so the
  // classifier eval `review-item-replies.eval.ts` checks it with the real model.
  // These cases cover the rules that apply before or after that choice.
  it("keeps a question open when the person who replies may not answer it", async () => {
    const { reply, state } = harness({
      allowedDomains: ["example.com"],
    });
    const emails: Record<string, string> = {
      U123: "ana@example.com",
      U456: "ben@example.com",
      UOUT: "someone@contractor.dev",
    };
    mswServer.use(
      http.post("https://slack.com/api/users.info", async ({ request }) => {
        const user = new URLSearchParams(await request.text()).get("user")!;
        return HttpResponse.json(
          usersInfoOk({ userId: user, email: emails[user] }),
        );
      }),
    );
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await linkSlackUser("ben@example.com", "U456");

    // The agent asks without naming anyone, so the question goes to Ana.
    const { item } = await addItem(ana, {
      kind: "action",
      title: "Ship release 1.2.3",
      body: "The release checks passed.",
      request: SHIP_REQUEST,
    });
    expect(item.assignees).toEqual(["ana@example.com"]);

    // Ben is not assigned, so his reply does not answer for Ana.
    await reply("U456", "1712345.0003");
    expect((await getReviewItem(getDb(), item.id))?.status).toBe("open");

    // A question with no assignees takes an answer from anyone, but not
    // from a Slack author outside the allowed domains. A Slack Actor without
    // a Junior User asks one.
    const unassigned = await (
      createAddReviewItemTool(
        {
          conversationId: THREAD,
          resolveActorIdentity: async () => ({
            identity: { id: "identity:slack:UNOUSER" } as any,
          }),
          source: { kind: "slack" } as any,
        },
        createSlackReviewItemToolServices(
          createConversationWorkQueueTestAdapter,
        ),
      ) as any
    ).execute(
      {
        kind: "action",
        title: "Ship release 1.2.4",
        body: "The release checks passed.",
        dedupe_key: "release:1.2.4",
        request: SHIP_REQUEST,
      },
      {},
    );
    expect(unassigned.item.assignees).toEqual([]);
    // Junior follows the thread, so a reply needs no mention to start a Turn.
    await state.subscribe(THREAD);
    await reply("UOUT", "1712345.0006", { mention: false });
    expect((await getReviewItem(getDb(), unassigned.item.id))?.status).toBe(
      "open",
    );

    // Both replies still reach the agent.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages.map((message) => message.input.authorId)).toEqual([
      "U456",
      "UOUT",
    ]);
    expect(slackApiOutbox.calls("chat.update")).toHaveLength(0);
  });

  it("delivers a question that a reply closed again when the reply is retried", async () => {
    const { postInDashboard, queue } = harness();
    await slackThread(THREAD, "public");
    await slackThread(OTHER_THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    const { item } = await addItem(ana, {
      kind: "action",
      title: "Ship release 1.2.3",
      body: "The release checks passed.",
      request: SHIP_REQUEST,
      conversation_ids: [OTHER_THREAD],
    });
    // Ana's first reply closed the item, but its delivery did not finish.
    await closeReviewItem(getDb(), {
      answer: {
        other: "Hold, the tests are red.",
        requestId: item.id,
        values: {},
      },
      closedByUserId: ana.id,
      id: item.id,
      nowMs: Date.now(),
      reason: REVIEW_ITEM_REPLIED_REASON,
      status: "done",
    });

    // The retry needs no decision: it shows the close on the card and wakes
    // the other linked thread.
    expect((await postInDashboard(ana)).status).toBe(200);
    expect(
      JSON.stringify(blocksOf(slackApiOutbox.calls("chat.update")[0])),
    ).toContain("ana@example.com replied in the thread");
    expect(
      queue.sentRecords().map((record) => record.conversationId),
    ).toContain(OTHER_THREAD);
  });
});
