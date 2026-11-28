import { createAskUserQuestionTool } from "@/chat/questions/tools/ask-user-question";
import { createUpdateInboxItemTool } from "@/chat/inbox-items/tools/update";
import { type Identity, type User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { expect, vi } from "vitest";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { closeDb, getConversationStore } from "@/chat/db";
import { patchConfig } from "../config";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";
import {
  SLACK_BOT_USER_ID,
  SLACK_SIGNING_SECRET,
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  createSlackAdapterFixture,
} from "../conversation-work";
import { slackEventsApiEnvelope } from "./factories/events";
import { createSlackWebhookTestClient } from "./webhook-client";
import { resetTestEnv } from "../stub-env";
export const THREAD = "slack:C123:1712345.0001";
export const OTHER_THREAD = "slack:C456:1712345.0009";
// The Slack API mock gives every posted message this ts.
export const CARD_TS = "1700000000.100";

export const SHIP_QUESTION = {
  question: "Ship release 1.2.3?",
  header: "Decision",
  options: [
    { label: "Ship it (Recommended)", description: "The checks passed." },
    { label: "Hold", description: "Wait for the next train." },
  ],
};

/** `SHIP_QUESTION` with other choices, for `updateInboxItem`. */
export function shipQuestions(labels: string[]) {
  return [
    {
      ...SHIP_QUESTION,
      options: labels.map((label) => ({
        label,
        description: `Pick ${label}.`,
      })),
    },
  ];
}

export async function slackThread(
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

/**
 * Ask a question as `user`'s agent. `conversation_ids` links more
 * Conversations after the ask, with `updateInboxItem`, as an agent does.
 */
export async function addItem(
  user: User,
  { conversation_ids, ...input }: Record<string, unknown>,
  conversationId = THREAD,
) {
  const tool = createAskUserQuestionTool(
    {
      conversationId,
      resolveActorIdentity: async () => ({
        identity: { id: `identity:${user.id}` } as Identity,
        user,
      }),
      source: { kind: "slack" } as any,
    },
    createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
  );
  const added = (await (tool as any).execute(
    (tool as any).prepareArguments(input),
    {},
  )) as {
    item: { assignees: string[]; id: string; subject: { id: string } };
  };
  if (conversation_ids) {
    await updateItem(
      user,
      { id: added.item.id, conversation_ids },
      conversationId,
    );
  }
  return added;
}

export async function updateItem(
  user: User,
  input: Record<string, unknown>,
  conversationId = THREAD,
) {
  const tool = createUpdateInboxItemTool(
    {
      conversationId,
      resolveActorIdentity: async () => ({
        identity: { id: `identity:${user.id}` } as Identity,
        user,
      }),
      source: { kind: "slack" } as any,
    },
    createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
  );
  return (await (tool as any).execute(input, {})) as {
    item: { assignees: string[]; conversation_ids: string[]; id: string };
  };
}

export function blocksOf(
  call: { params: Record<string, unknown> } | undefined,
) {
  const blocks = call?.params["blocks"];
  return (typeof blocks === "string" ? JSON.parse(blocks) : blocks) as Array<{
    elements?: Array<{
      action_id?: string;
      style?: string;
      text?: unknown;
      url?: string;
      value?: string;
    }>;
    text?: string;
    type: string;
  }>;
}

/** The value of one button on a posted card, as Slack sends it back. */
export function buttonValue(
  call: { params: Record<string, unknown> } | undefined,
  actionId: string,
): string {
  const value = blocksOf(call)
    .flatMap((block) => block.elements ?? [])
    .find((element) => element.action_id === actionId)?.value;
  if (!value) throw new Error(`no button ${actionId}`);
  return value;
}

/** Give each test the Slack bot token and fresh Slack API mocks. */
export function setUpInboxItemCards(): void {
  resetTestEnv({ SLACK_BOT_TOKEN: "xoxb-test-token" });
  resetSlackApiMockState();
}

/** Restore the env, state, and database after each test. */
export async function tearDownInboxItemCards(): Promise<void> {
  vi.unstubAllEnvs();
  resetSlackApiMockState();
  await disconnectStateAdapter();
  await closeDb();
}

/**
 * Drive Slack card clicks, thread replies, and dashboard messages through
 * the real Slack webhook and API routes.
 */
export function inboxItemCardHarness(
  options: { allowedDomains?: string[] } = {},
) {
  // Slack ingress reads the allowed domains that `createApp` applies.
  patchConfig({
    trust: {
      allowedBotUserIds: [],
      allowedDomains: options.allowedDomains ?? [],
    },
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
