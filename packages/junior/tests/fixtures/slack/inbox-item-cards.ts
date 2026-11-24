import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import { type Identity, type User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { expect } from "vitest";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { closeDb, getConversationStore } from "@/chat/db";
import { setTrustConfig } from "@/chat/identities/trust";
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

const ORIGINAL_ENV = { ...process.env };
export const THREAD = "slack:C123:1712345.0001";
export const OTHER_THREAD = "slack:C456:1712345.0009";
// The Slack API mock gives every posted message this ts.
export const CARD_TS = "1700000000.100";

export const SHIP_REQUEST = {
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

export async function addItem(
  user: User,
  input: Record<string, unknown>,
  conversationId = THREAD,
) {
  const tool = createAddInboxItemTool(
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
    item: { assignees: string[]; id: string };
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
  process.env = { ...ORIGINAL_ENV, SLACK_BOT_TOKEN: "xoxb-test-token" };
  resetSlackApiMockState();
}

/** Restore the env, trust config, state, and database after each test. */
export async function tearDownInboxItemCards(): Promise<void> {
  process.env = { ...ORIGINAL_ENV };
  resetSlackApiMockState();
  setTrustConfig({ allowedBotUserIds: [], allowedDomains: [] });
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
