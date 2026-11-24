import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { defineJuniorPlugin, type User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import {
  pauseConversationDelivery,
  resumeConversationDelivery,
} from "@/chat/conversations/delivery-pause";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { setTrustConfig } from "@/chat/identities/trust";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { createApp, defineJuniorPlugins } from "@/app";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
import { createPluginInboxItems } from "@/chat/inbox-items/plugin";
import {
  closeInboxItem,
  getInboxItem,
  INBOX_ITEM_REPLIED_REASON,
} from "@/chat/inbox-items/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { juniorInboxItems } from "@/db/schema";
import { createInboxItemShow } from "@/chat/notifications/inbox-item-show";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
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
import {
  CARD_TS,
  OTHER_THREAD,
  SHIP_REQUEST,
  THREAD,
  addItem,
  blocksOf,
  buttonValue,
  recordedChanges,
  slackThread,
} from "../../fixtures/slack/inbox-item-cards";

const ORIGINAL_ENV = { ...process.env };
describe("Slack webhook: Inbox item cards", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: "xoxb-test-token" };
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    setTrustConfig({ allowedBotUserIds: [], allowedDomains: [] });
    await disconnectStateAdapter();
    await closeDb();
  });

  function harness(options: { allowedDomains?: string[] } = {}) {
    // Slack ingress reads the allowed domains that `createApp` applies.
    setTrustConfig({
      allowedBotUserIds: [],
      allowedDomains: options.allowedDomains ?? [],
    });
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
          waitUntil: () => undefined,
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
    expect(posts.map((post) => post.params["channel"]).sort()).toEqual([
      "C123",
      "C456",
    ]);
    const controls = blocksOf(posts[0]).find(
      (block) => block.type === "actions",
    );
    expect(
      controls?.elements?.map((element) => [element.action_id, element.style]),
    ).toEqual([
      ["junior_review_item:dismiss", undefined],
      ["junior_review_item:choice:0", "primary"],
      ["junior_review_item:choice:1", undefined],
      ["junior_review_item:answer", undefined],
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
      `answered inbox item "Ship release 1.2.3" (${item.id})`,
    );
    expect(work?.messages[0]?.input.text).toContain(
      "Decision (decision): Ship it",
    );
    // The input records the answer, so its saved Message shows as one.
    expect(work?.messages[0]?.input.reviewItemChange).toEqual({
      kind: "submitted",
      reviewItemId: item.id,
    });
    // The click starts input in a thread no Conversation claimed, so it
    // claims the thread for this one.
    await expect(
      getConversationStore().getConversationIdByProviderConversation({
        provider: "slack",
        providerConversationId: "1712345.0001",
        providerDestinationId: "C123",
        providerTenantId: "T123",
      }),
    ).resolves.toBe(THREAD);
    // The answer goes only to the agent that asked. The other linked thread
    // records it once, and gets no input that starts a Turn.
    const other = await getConversationWorkState({
      conversationId: OTHER_THREAD,
      state,
    });
    expect(other?.messages ?? []).toHaveLength(0);
    expect(await recordedChanges(OTHER_THREAD)).toEqual([
      { kind: "submitted", reviewItemId: item.id },
    ]);

    // Both cards lose their controls and show the answer.
    const updates = slackApiOutbox
      .calls("chat.update")
      .slice(updatesBeforeClose);
    expect(
      updates.slice(0, 2).map((update) => update.params["channel"]),
    ).toEqual(expect.arrayContaining(["C123", "C456"]));
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
          text: "Inbox item is closed.",
          user: "U123",
        }),
        expect.objectContaining({
          text: "Inbox item is closed.",
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

  it("gives a click on a plugin item's choice to the plugin, with no Turn", async () => {
    const answers: string[] = [];
    let fails = true;
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "deploys",
            displayName: "Deploys",
            description: "Deploy test plugin",
          },
          hooks: {
            inboxItemAnswered: ({ choice, dedupeKey }) => {
              answers.push(`${dedupeKey}: ${choice}`);
              if (fails) throw new Error("deploy API is down");
            },
          },
        }),
      ]),
    });
    const { click, state } = harness();
    await slackThread(THREAD, "public");
    await linkSlackUser("ana@example.com", "U123");
    await createPluginInboxItems({
      conversationId: THREAD,
      plugin: "deploys",
      show: createInboxItemShow(createSlackAdapterFixture),
    }).upsert({
      assigneeIdentityIds: ["identity:U123"],
      body: "Deploys of `api` stopped after 3 failures.",
      choices: [{ label: "Resume" }],
      dedupeKey: "deploy-stopped:api",
      title: "Deploys stopped · api",
    });

    // The card asks the body once, and has one button and no Other….
    const [card] = slackApiOutbox.messages();
    const text = blocksOf(card)[0]?.text ?? "";
    expect(text.split("Deploys of `api` stopped")).toHaveLength(2);
    expect(
      blocksOf(card)
        .find((block) => block.type === "actions")
        ?.elements?.map((element) => element.action_id),
    ).toEqual(["junior_review_item:dismiss", "junior_review_item:choice:0"]);

    const [item] = await getDb().select().from(juniorInboxItems);
    const resume = (actionTs: string) =>
      click({
        actionId: "junior_review_item:choice:0",
        actionTs,
        itemId: item!.id,
        userId: "U123",
        value: buttonValue(card, "junior_review_item:choice:0"),
      });
    // The plugin fails after the click closes the item. The card keeps its
    // button, and a second click calls the plugin again.
    await resume("1712345.0003").catch(() => undefined);
    fails = false;
    await resume("1712345.0004");
    expect(answers).toEqual([
      "deploy-stopped:api: Resume",
      "deploy-stopped:api: Resume",
    ]);
    expect(await getInboxItem(getDb(), item!.id)).toMatchObject({
      status: "done",
    });
    // The plugin does the work, so the thread starts no Turn.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages ?? []).toEqual([]);
  });

  it("posts one card in a thread that a linked child agent shares", async () => {
    const { click, state } = harness();
    await slackThread(THREAD, "public");
    // A child agent shares the thread of its parent.
    const child = "agent:card-child";
    await getConversationStore().createChild({
      childConversationId: child,
      kind: "thread",
      nowMs: 1,
      parentConversationId: THREAD,
      source: "internal",
    });
    const ana = await linkSlackUser("ana@example.com", "U123");
    const input = {
      kind: "action",
      title: "Ship release 1.2.3",
      body: "The release checks passed.",
      assignees: ["ana@example.com"],
      dedupe_key: "release:1.2.3",
      request: SHIP_REQUEST,
    };
    // The child adds the item first, and the parent links it later. The
    // thread keeps one card.
    await addItem(ana, input, child);
    const { item } = await addItem(ana, input);
    expect(item).toMatchObject({ conversation_ids: [child, THREAD] });
    const cards = slackApiOutbox.messages();
    expect(cards).toHaveLength(1);

    await click({
      actionId: "junior_review_item:choice:0",
      actionTs: "1712345.0003",
      itemId: item.id,
      userId: "U123",
      value: buttonValue(cards[0], "junior_review_item:choice:0"),
    });

    // The child asked, so only the child gets the answer, once, as Ana's
    // own input. The parent owns the thread, but it only records the answer.
    const childWork = await getConversationWorkState({
      conversationId: child,
      state,
    });
    expect(childWork?.messages).toHaveLength(1);
    expect(childWork?.messages[0]).toMatchObject({
      input: { reviewItemChange: { kind: "submitted", reviewItemId: item.id } },
      source: "web",
    });
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    // The parent got only the child's `waiting` update.
    expect(work?.messages.map((message) => message.input.text)).toEqual([
      expect.stringContaining('status="waiting"'),
    ]);
    expect(await recordedChanges(THREAD)).toEqual([
      { kind: "submitted", reviewItemId: item.id },
    ]);
  });

  it("posts no card in a detached thread until it attaches again", async () => {
    harness();
    await slackThread(THREAD, "public");
    // A child agent's item reads the detach of its root.
    const child = "agent:detached-child";
    await getConversationStore().createChild({
      childConversationId: child,
      kind: "thread",
      nowMs: 1,
      parentConversationId: THREAD,
      source: "internal",
    });
    await pauseConversationDelivery(THREAD);
    const ana = await linkSlackUser("ana@example.com", "U123");
    const input = {
      kind: "action",
      title: "Ship release 1.2.3",
      body: "The release checks passed.",
      assignees: ["ana@example.com"],
      dedupe_key: "release:1.2.3",
      request: SHIP_REQUEST,
    };
    await addItem(ana, input, child);
    await addItem(ana, input);
    expect(slackApiOutbox.messages()).toHaveLength(0);

    await resumeConversationDelivery(THREAD);
    await addItem(ana, input);
    expect(slackApiOutbox.messages()).toHaveLength(1);
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

  it("orders a card Dismiss, Snooze, then the answer, with Snooze in the dashboard", async () => {
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      harness();
      await slackThread(THREAD, "public");
      const ana = await linkSlackUser("ana@example.com", "U123");
      const { item } = await addItem(ana, {
        kind: "action",
        title: "Ship release 1.2.3",
        body: "The release checks passed.",
        assignees: ["everyone"],
        dedupe_key: "release:1.2.3",
        request: SHIP_REQUEST,
      });

      const [post] = slackApiOutbox.messages();
      const controls = blocksOf(post).find((block) => block.type === "actions");
      // A Slack message looks the same to everyone, so Snooze opens the
      // item's snooze form in the dashboard, for the person who clicks.
      expect(
        controls?.elements?.map((element) => [
          element.action_id,
          element.url ?? null,
        ]),
      ).toEqual([
        ["junior_review_item:dismiss", null],
        [
          "junior_review_item:snooze",
          `https://junior.example.com/inbox?item=${encodeURIComponent(item.id)}&snooze=1`,
        ],
        ["junior_review_item:choice:0", null],
        ["junior_review_item:choice:1", null],
        ["junior_review_item:answer", null],
      ]);
    } finally {
      setDashboardConversationLinkOptions(undefined);
    }
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

      await actOnInboxItem({
        action: "submit",
        answer: { requestId: item.id, values: { notes: ["x".repeat(3_000)] } },
        delivery: { queue, show: createInboxItemShow() },
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
        expect.stringContaining("|Open in the Inbox>"),
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
    expect(posts.map((post) => post.params["channel"])).toEqual(["C123"]);
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
      { text: "Inbox item not found.", user: "U456" },
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
  // classifier eval `inbox-item-replies.eval.ts` checks it with the real model.
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
    expect((await getInboxItem(getDb(), item.id))?.status).toBe("open");

    // A Slack Actor without a Junior User asks a question with no
    // assignees. It is for Everyone, so a reply never answers it.
    const unassigned = await (
      createAddInboxItemTool(
        {
          conversationId: THREAD,
          resolveActorIdentity: async () => ({
            identity: { id: "identity:slack:UNOUSER" } as any,
          }),
          source: { kind: "slack" } as any,
        },
        createSlackInboxItemToolServices(
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
    // Even when the decision model would match it, Ben's reply leaves it
    // open, as it leaves an Everyone question open.
    mswServer.use(
      http.post("*/decision-model", async ({ request }) => {
        const { questions } = (await request.json()) as {
          questions: Record<string, unknown>;
        };
        return HttpResponse.json({
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { type: "choice", choice: "answers" },
            ]),
          ),
        });
      }),
    );
    await reply("U456", "1712345.0007", { mention: false });
    expect((await getInboxItem(getDb(), unassigned.item.id))?.status).toBe(
      "open",
    );

    // Every reply still reaches the agent.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages.map((message) => message.input.authorId)).toEqual([
      "U456",
      "UOUT",
      "U456",
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
    await closeInboxItem(getDb(), {
      answer: {
        other: "Hold, the tests are red.",
        requestId: item.id,
        values: {},
      },
      closedByUserId: ana.id,
      id: item.id,
      nowMs: Date.now(),
      reason: INBOX_ITEM_REPLIED_REASON,
      status: "done",
    });

    // The retry needs no decision: it shows the close on the card and
    // records it in the other linked thread, with no Turn there.
    expect((await postInDashboard(ana)).status).toBe(200);
    expect(
      JSON.stringify(blocksOf(slackApiOutbox.calls("chat.update")[0])),
    ).toContain("ana@example.com replied in the thread");
    expect(
      queue.sentRecords().map((record) => record.conversationId),
    ).not.toContain(OTHER_THREAD);
    const recorded = projectConversationMessages(
      await getConversationEventStore().loadMessageHistory(OTHER_THREAD),
    );
    expect(recorded.map((message) => message.text)).toEqual([
      expect.stringContaining("replied in a thread linked to inbox item"),
    ]);
  });
});
