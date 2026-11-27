import { createAskUserQuestionTool } from "@/chat/inbox-items/tools/ask-user-question";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pauseConversationDelivery,
  resumeConversationDelivery,
} from "@/chat/conversations/delivery-pause";
import { getConversationStore, getDb } from "@/chat/db";
import { createApp, defineJuniorPlugins } from "@/app";
import { actOnInboxItem } from "@/chat/inbox-items/actions";
import {
  closeInboxItem,
  getInboxItem,
  INBOX_ITEM_REPLIED_REASON,
  insertInboxItem,
} from "@/chat/inbox-items/store";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { juniorInboxItems } from "@/db/schema";
import { createInboxItemShow } from "@/chat/notifications/inbox-item-show";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { SLACK_MAX_MARKDOWN_CHARS } from "@/chat/slack/limits";
import { mswServer } from "../../msw/server";
import {
  createConversationWorkQueueTestAdapter,
  createSlackAdapterFixture,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { linkSlackUser } from "../../fixtures/slack-user";
import { usersInfoOk } from "../../fixtures/slack/factories/api";

import {
  OTHER_THREAD,
  SHIP_QUESTION,
  THREAD,
  addItem,
  blocksOf,
  buttonValue,
  inboxItemCardHarness,
  setUpInboxItemCards,
  shipQuestions,
  slackThread,
  tearDownInboxItemCards,
  updateItem,
} from "../../fixtures/slack/inbox-item-cards";
import { patchConfig } from "../../fixtures/config";
import {
  ownedPluginInboxItems,
  TEST_PLUGIN_INBOX_OWNER,
} from "../../fixtures/plugin-inbox-owners";

describe("Slack webhook: Inbox item cards", () => {
  beforeEach(setUpInboxItemCards);
  afterEach(tearDownInboxItemCards);

  it("closes an item everywhere on the first click in a Slack card", async () => {
    const { click, state } = inboxItemCardHarness();
    await slackThread(THREAD, "public");
    await slackThread(OTHER_THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await linkSlackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      assignees: ["everyone"],
      questions: [SHIP_QUESTION],
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

    // The choices change. A click on the old card cannot pick a choice that
    // the item no longer offers.
    const shipIt = buttonValue(posts[0], "junior_review_item:choice:0");
    const changeChoices = async (labels: string[]) => {
      await updateItem(ana, { id: item.id, questions: shipQuestions(labels) });
    };
    await changeChoices(["Hold", "Wait"]);
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
    await changeChoices(["Hold", "Ship it"]);
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
      `answered inbox item "Ship release 1.2.3?" (${item.id})`,
    );
    expect(work?.messages[0]?.input.text).toContain("Decision (q1): Ship it");
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
    // The other linked thread learns about it once, from the person.
    const other = await getConversationWorkState({
      conversationId: OTHER_THREAD,
      state,
    });
    expect(other?.messages).toHaveLength(1);
    expect(other?.messages[0]?.input.text).toContain("answered inbox item");
    expect(other?.messages[0]?.input.reviewItemChange).toEqual({
      kind: "submitted",
      reviewItemId: item.id,
    });

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
    const { click, state } = inboxItemCardHarness();
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
        assignees: ["ana@example.com"],
        questions: [SHIP_QUESTION],
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
    expect(work?.messages[0]?.input.text).toContain("Decision (q1): Ship it");
  });

  it("gives a click on a plugin item's choice to the plugin, with no Turn", async () => {
    const answers: string[] = [];
    let fails = true;
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          inboxSubjects: [
            {
              kind: "deploy_stopped",
              label: "Deploys stopped",
              owner: TEST_PLUGIN_INBOX_OWNER,
            },
          ],
          manifest: {
            name: "deploys",
            displayName: "Deploys",
            description: "Deploy test plugin",
          },
          hooks: {
            inboxItemAnswered: ({ choice, subject }) => {
              answers.push(`${subject.id}: ${choice}`);
              if (fails) throw new Error("deploy API is down");
            },
          },
        }),
      ]),
    });
    const { click, state } = inboxItemCardHarness();
    await slackThread(THREAD, "public");
    await linkSlackUser("ana@example.com", "U123");
    await ownedPluginInboxItems({
      conversationId: THREAD,
      plugin: "deploys",
      show: createInboxItemShow(createSlackAdapterFixture),
    }).upsert({
      askedIdentityIds: ["identity:U123"],
      assigneeIdentityIds: ["identity:U123"],
      body: "Deploys of `api` stopped after 3 failures.",
      choices: [{ label: "Resume" }],
      subject: { id: "api", kind: "deploy_stopped" },
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
    expect(answers).toEqual(["api: Resume", "api: Resume"]);
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
    const { click, state } = inboxItemCardHarness();
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
      assignees: ["ana@example.com"],
      questions: [SHIP_QUESTION],
    };
    // The child adds the item first, and the parent links it later. The
    // thread keeps one card.
    const added = await addItem(ana, input, child);
    const { item } = await updateItem(ana, {
      id: added.item.id,
      conversation_ids: [child, THREAD],
    });
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

    // A click acts for the parent, which owns the thread, so the parent gets
    // the answer once.
    const work = await getConversationWorkState({
      conversationId: THREAD,
      state,
    });
    expect(work?.messages).toHaveLength(1);
    expect(work?.messages[0]?.input).toMatchObject({ authorId: "U123" });
  });

  it("posts no card in a detached thread until it attaches again", async () => {
    inboxItemCardHarness();
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
      assignees: ["ana@example.com"],
      questions: [SHIP_QUESTION],
    };
    const { item } = await addItem(ana, input, child);
    await updateItem(ana, { id: item.id, conversation_ids: [child, THREAD] });
    expect(slackApiOutbox.messages()).toHaveLength(0);

    await resumeConversationDelivery(THREAD);
    await updateItem(ana, {
      id: item.id,
      questions: [{ ...SHIP_QUESTION, question: "Ship release 1.2.3 now?" }],
    });
    expect(slackApiOutbox.messages()).toHaveLength(1);
  });

  it("shows each question of a card with its own choices", async () => {
    inboxItemCardHarness();
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    await addItem(ana, {
      assignees: ["everyone"],
      questions: [
        {
          question: "When should the rollout start?",
          header: "Window",
          options: [
            {
              label: "Tuesday 02:00 UTC (Recommended)",
              description: "The quietest hour.",
            },
            { label: "Thursday 02:00 UTC", description: "After the freeze." },
          ],
        },
        {
          question: "Which regions go first?",
          header: "Regions",
          multiSelect: true,
          options: [
            { label: "us", description: "Most traffic." },
            { label: "eu", description: "Least traffic." },
          ],
        },
      ],
    });

    // No question sits above the two: each shows its own text and choices,
    // and a card of two questions answers in a form, not with buttons.
    const [post] = slackApiOutbox.messages();
    const text = blocksOf(post).find(
      (block) => block.type === "markdown",
    )?.text;
    expect(text).toContain("**Window**: When should the rollout start?");
    expect(text).toContain("Tuesday 02:00 UTC (suggested), Thursday 02:00 UTC");
    expect(text).toContain("**Regions**: Which regions go first?");
    expect(
      blocksOf(post)
        .find((block) => block.type === "actions")
        ?.elements?.map((element) => element.action_id),
    ).toEqual(["junior_review_item:dismiss", "junior_review_item:answer"]);
  });

  it("lists the related links that a stored item has below its body", async () => {
    patchConfig({ dashboard: { baseURL: "https://junior.example" } });
    inboxItemCardHarness();
    await slackThread(THREAD, "public");
    await slackThread(OTHER_THREAD, "public");
    const related = [
      { label: "Canary [errors]", url: "https://example.com/canary" },
      // The same link again shows once.
      { label: "Canary", url: "https://example.com/canary" },
      { label: "Checkout latency", conversationId: OTHER_THREAD },
    ];
    // Agents stored related links before `askUserQuestion`, on a question
    // and on a notice.
    const show = createInboxItemShow();
    const stored = [
      {
        body: "The canary is green.",
        kind: "action" as const,
        request: {
          question: "Ship release 1.2.3?",
          fields: [
            {
              id: "decision",
              kind: "choice" as const,
              label: "Decision",
              options: [{ label: "Ship it" }, { label: "Hold" }],
            },
          ],
          related,
        },
        title: "Roll out payments-v42?",
      },
      {
        body: "All regions are on payments-v42.",
        kind: "notice" as const,
        request: { related },
        title: "payments-v42 rolled out",
      },
    ];
    for (const [index, item] of stored.entries()) {
      const added = await insertInboxItem(getDb(), {
        ...item,
        assignedToEveryone: true,
        assigneeUserIds: [],
        conversationIds: [THREAD],
        nowMs: Date.now(),
        owner: { id: THREAD, kind: "conversation" },
        subject: { id: `ask:legacy-${index}`, kind: "question" },
      });
      await show(added!.id);
    }

    const conversation = `https://junior.example/conversations/${encodeURIComponent(OTHER_THREAD)}`;
    const lines = slackApiOutbox.messages().map((post) => {
      const markdown = blocksOf(post).find(
        (block) => block.type === "markdown",
      );
      return markdown?.text;
    });
    // The links show on the card as plain links, and the title links to
    // nothing: they do not decide the card.
    expect(lines[0]).toContain(
      `**Roll out payments-v42?**\n\nThe canary is green.\n\nRelated: [Canary \\[errors\\]](https://example.com/canary) · [Checkout latency](${conversation})\n\n`,
    );
    expect(lines[1]).toBe(
      `**payments-v42 rolled out**\n\nAll regions are on payments-v42.\n\nRelated: [Canary \\[errors\\]](https://example.com/canary) · [Checkout latency](${conversation})`,
    );
  });

  it("orders a card Dismiss, Snooze, then the answer, with Snooze in the dashboard", async () => {
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });
    inboxItemCardHarness();
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    const { item } = await addItem(ana, {
      assignees: ["everyone"],
      questions: [SHIP_QUESTION],
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
  });

  it("keeps a long answer inside the Slack limits of a card", async () => {
    patchConfig({
      dashboard: {
        baseURL: "https://junior.example.com",
      },
    });
    const { queue } = inboxItemCardHarness();
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    const { item } = await addItem(ana, {
      assignees: ["ana@example.com"],
      questions: [SHIP_QUESTION],
    });

    await actOnInboxItem({
      action: "submit",
      answer: { requestId: item.id, other: "x".repeat(3_000), values: {} },
      delivery: { queue, show: createInboxItemShow() },
      id: item.id,
      user: ana,
    });

    // Slack rejects a context element over 3,000 characters, and then the
    // card keeps its controls.
    const [update] = slackApiOutbox.calls("chat.update");
    const context = blocksOf(update).find((block) => block.type === "context");
    const texts = (context?.elements ?? []).map(
      (element) => element.text as string,
    );
    expect(texts).toEqual([
      expect.stringContaining("ana@example.com answered"),
      expect.stringContaining("|Open in the Inbox>"),
    ]);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(3_000);
  });

  it("shortens the body of a long item to fit Slack's markdown limit", async () => {
    inboxItemCardHarness();
    await slackThread(THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    const question = (id: string) =>
      `Which checks of ${id} should block the release? `.repeat(22).trim();
    await addItem(ana, {
      assignees: ["everyone"],
      questions: ["a", "b", "c", "d"].map((id) => ({
        question: question(id),
        header: `Checks ${id}`,
        multiSelect: true,
        options: Array.from({ length: 4 }, (_, index) => ({
          label: `Check ${index} of ${id}`.padEnd(75, "."),
          description: "Pick it when this check must pass. ".repeat(5).trim(),
        })),
      })),
    });

    const [post] = slackApiOutbox.messages();
    const markdown = blocksOf(post).find((block) => block.type === "markdown");
    expect(markdown?.text?.length).toBeLessThanOrEqual(
      SLACK_MAX_MARKDOWN_CHARS,
    );
    expect(markdown?.text).toContain(question("a"));
    expect(markdown?.text).toContain("Check 3 of d");
  });

  // Which open question a reply answers is a decision model choice, so the
  // classifier eval `inbox-item-replies.eval.ts` checks it with the real model.
  // These cases cover the rules that apply before or after that choice.
  it("keeps a question open when the person who replies may not answer it", async () => {
    const { reply, state } = inboxItemCardHarness({
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
      questions: [SHIP_QUESTION],
    });
    expect(item.assignees).toEqual(["ana@example.com"]);

    // Ben is not assigned, so his reply does not answer for Ana.
    await reply("U456", "1712345.0003");
    expect((await getInboxItem(getDb(), item.id))?.status).toBe("open");

    // A Slack Actor without a Junior User asks a question with no
    // assignees. It is for Everyone, so a reply never answers it.
    const unassignedTool = createAskUserQuestionTool(
      {
        conversationId: THREAD,
        resolveActorIdentity: async () => ({
          identity: { id: "identity:slack:UNOUSER" } as any,
        }),
        source: { kind: "slack" } as any,
      },
      createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
    ) as any;
    const unassigned = await unassignedTool.execute(
      unassignedTool.prepareArguments({ questions: [SHIP_QUESTION] }),
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
    const { postInDashboard, queue } = inboxItemCardHarness();
    await slackThread(THREAD, "public");
    await slackThread(OTHER_THREAD, "public");
    const ana = await linkSlackUser("ana@example.com", "U123");
    const { item } = await addItem(ana, {
      questions: [SHIP_QUESTION],
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

    // The retry needs no decision: it shows the close on the card and wakes
    // the other linked thread.
    expect((await postInDashboard(ana)).status).toBe(200);
    expect(
      JSON.stringify(blocksOf(slackApiOutbox.calls("chat.update").at(-1))),
    ).toContain("ana@example.com replied in the thread");
    expect(
      queue.sentRecords().map((record) => record.conversationId),
    ).toContain(OTHER_THREAD);
  });
});
