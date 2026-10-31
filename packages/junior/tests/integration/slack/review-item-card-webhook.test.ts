import type { Identity, User } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { actOnReviewItem } from "@/chat/review-items/actions";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { createSlackReviewItemShow } from "@/chat/slack/review-item-card-sync";
import { createSlackReviewItemToolServices } from "@/chat/slack/review-item-tools";
import { createAddReviewItemTool } from "@/chat/tools/review-items";
import { juniorIdentities } from "@/db/schema";
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
      options: [{ label: "Ship it" }, { label: "Hold" }],
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

/** A Junior User with a linked Slack identity, like a person who signed in. */
async function slackUser(email: string, slackUserId: string): Promise<User> {
  const user = await resolveViewerUserFromSql(getDb(), email);
  if (!user) throw new Error(`no user for ${email}`);
  const now = new Date(1);
  await getDb()
    .insert(juniorIdentities)
    .values({
      createdAt: now,
      displayName: email.split("@")[0]!,
      email,
      emailNormalized: email,
      emailVerified: true,
      id: `identity:${slackUserId}`,
      kind: "user",
      provider: "slack",
      providerSubjectId: slackUserId,
      providerTenantId: "T123",
      updatedAt: now,
      userId: user.id,
    })
    .onConflictDoUpdate({
      target: [
        juniorIdentities.provider,
        juniorIdentities.providerTenantId,
        juniorIdentities.providerSubjectId,
      ],
      set: { userId: user.id },
    });
  return user;
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
    item: { id: string };
  };
}

function blocksOf(call: { params: Record<string, unknown> } | undefined) {
  const blocks = call?.params.blocks;
  return (typeof blocks === "string" ? JSON.parse(blocks) : blocks) as Array<{
    elements?: Array<{ action_id?: string; text?: unknown; value?: string }>;
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

  function harness() {
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
    return { click, interact, queue, state };
  }

  it("closes an item everywhere on the first click in a Slack card", async () => {
    const { click, state } = harness();
    await slackThread(THREAD, "public");
    await slackThread(OTHER_THREAD, "public");
    const ana = await slackUser("ana@example.com", "U123");
    await slackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      kind: "action",
      title: "Ship release 1.2.3",
      body: "The release checks passed.",
      assignees: ["everyone"],
      dedupe_key: "release:1.2.3",
      request: SHIP_REQUEST,
      conversation_ids: [OTHER_THREAD],
    });

    // Each linked thread gets a card with one button per choice.
    const posts = slackApiOutbox.messages();
    expect(posts.map((post) => post.params.channel).sort()).toEqual([
      "C123",
      "C456",
    ]);
    const controls = blocksOf(posts[0]).find(
      (block) => block.type === "actions",
    );
    expect(controls?.elements?.map((element) => element.action_id)).toEqual([
      "junior_review_item:choice:0",
      "junior_review_item:choice:1",
      "junior_review_item:answer",
      "junior_review_item:dismiss",
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
    // The other linked thread learns about it once, from the person.
    const other = await getConversationWorkState({
      conversationId: OTHER_THREAD,
      state,
    });
    expect(other?.messages).toHaveLength(1);
    expect(other?.messages[0]?.input.text).toContain("answered review item");

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
    const ana = await slackUser("ana@example.com", "U123");
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

  it("keeps a long answer inside the Slack limits of a card", async () => {
    setDashboardConversationLinkOptions({
      baseURL: "https://junior.example.com",
    });
    try {
      const { queue } = harness();
      await slackThread(THREAD, "public");
      const ana = await slackUser("ana@example.com", "U123");
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
    const { click } = harness();
    await slackThread(THREAD, "private");
    const ana = await slackUser("ana@example.com", "U123");
    await slackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      kind: "notice",
      title: "Rotate the deploy key",
      body: "The deploy key expires on Friday.",
      assignees: ["ana@example.com"],
      dedupe_key: "deploy-key",
    });

    expect(
      slackApiOutbox.messages().map((post) => post.params.channel),
    ).toEqual(["C123"]);

    // Only an assignee can act. Ben gets an ephemeral note.
    await click({
      actionId: "junior_review_item:done",
      actionTs: "1712345.0003",
      itemId: item.id,
      userId: "U456",
    });
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params).toMatchObject(
      { text: "Review item not found.", user: "U456" },
    );

    await click({
      actionId: "junior_review_item:done",
      actionTs: "1712345.0004",
      itemId: item.id,
      userId: "U123",
    });
    const updates = slackApiOutbox.calls("chat.update");
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(blocksOf(updates[0]))).toContain(
      "ana@example.com marked this done",
    );
  });
});
