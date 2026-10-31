import type { Identity, User } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
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

async function addItem(user: User, input: Record<string, unknown>) {
  const tool = createAddReviewItemTool({
    conversationId: THREAD,
    resolveActorIdentity: async () => ({
      identity: { id: `identity:${user.id}` } as Identity,
      user,
    }),
    source: { kind: "slack" } as any,
  });
  return (await (tool as any).execute(input, {})) as {
    item: { id: string };
  };
}

function blocksOf(call: { params: Record<string, unknown> } | undefined) {
  const blocks = call?.params.blocks;
  return (typeof blocks === "string" ? JSON.parse(blocks) : blocks) as Array<{
    elements?: Array<{ action_id?: string; text?: unknown }>;
    type: string;
  }>;
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
            value: args.itemId,
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

    await click({
      actionId: "junior_review_item:choice:0",
      actionTs: "1712345.0003",
      itemId: item.id,
      userId: "U123",
    });
    // A second click on a stale card does not add a second Turn.
    await click({
      actionId: "junior_review_item:choice:1",
      actionTs: "1712345.0004",
      itemId: item.id,
      userId: "U456",
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
    const updates = slackApiOutbox.calls("chat.update");
    expect(
      updates.slice(0, 2).map((update) => update.params.channel),
    ).toEqual(expect.arrayContaining(["C123", "C456"]));
    for (const update of updates) {
      const blocks = blocksOf(update);
      expect(blocks.some((block) => block.type === "actions")).toBe(false);
      expect(JSON.stringify(blocks)).toContain("ana@example.com chose *Ship it*");
    }
    expect(slackApiOutbox.calls("chat.postEphemeral")[0]?.params).toMatchObject(
      { text: "This item is already closed.", user: "U456" },
    );
  });

  it("shows a private item only in the thread that added it", async () => {
    const { click } = harness();
    await slackThread(THREAD, "private");
    await slackThread(OTHER_THREAD, "private");
    const ana = await slackUser("ana@example.com", "U123");
    await slackUser("ben@example.com", "U456");

    const { item } = await addItem(ana, {
      kind: "notice",
      title: "Rotate the deploy key",
      body: "The deploy key expires on Friday.",
      assignees: ["ana@example.com"],
      dedupe_key: "deploy-key",
      conversation_ids: [OTHER_THREAD],
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
