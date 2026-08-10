import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createJuniorSlackAdapter } from "@/chat/slack/adapter";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";
import { handleSlackWebhook } from "@/chat/ingress/slack-webhook";
import { getWorkspaceTeamId } from "@/chat/slack/workspace-context";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getSqlExecutor } from "@/chat/db";
import {
  upsertIdentity,
  upsertLinkedIdentity,
} from "@/chat/identities/sql";
import { juniorIdentities } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import {
  queueSlackApiError,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
  deferred,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U0BOT";
const ORIGINAL_ENV = { ...process.env };

function createSlackAdapter() {
  return createJuniorSlackAdapter({
    botToken: "xoxb-test-token",
    botUserId: BOT_USER_ID,
    signingSecret: SIGNING_SECRET,
  });
}

function interactiveDisconnectPayload(
  provider: string = "notion",
): Record<string, unknown> {
  return {
    type: "block_actions",
    team: { id: "T123" },
    user: {
      id: "U123",
      team_id: "T123",
      username: "alice",
    },
    actions: [
      {
        action_id: "app_home_disconnect",
        value: provider,
      },
    ],
  };
}

function createTokenStore(
  overrides: Partial<UserTokenStore> = {},
): UserTokenStore {
  return {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    withRefresh: vi.fn(async (_userId, _provider, callback) => callback()),
    ...overrides,
  };
}

describe("Slack webhook: App Home events", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };
    resetSlackApiMockState();
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    resetSlackApiMockState();
    await disconnectStateAdapter();
  });

  it("acknowledges app_home_opened when publishing the view fails", async () => {
    queueSlackApiError("views.publish", {
      error: "internal_error",
      status: 200,
    });

    const state = createMemoryState();
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const queue = createConversationWorkQueueTestAdapter();
    const slackAdapter = createSlackAdapter();
    const waitUntil = client.waitUntil();

    const response = await handleSlackWebhook({
      request: client.event({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "app_home_opened",
          user: "U123",
          event_ts: "1712345.0001",
        },
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
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(1);
    await waitUntil.flush();
    expect(slackApiOutbox.homeViews()).toHaveLength(1);
  });

  it("acknowledges message events after durable handoff finishes", async () => {
    const state = createMemoryState();
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const finishQueueSend = deferred();
    let responseSettled = false;
    const queueSendEntered = queue.holdNextSendUntil(finishQueueSend.promise);
    const slackAdapter = createSlackAdapter();

    const responsePromise = handleSlackWebhook({
      request: client.event({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "app_mention",
          user: "U123",
          text: `<@${BOT_USER_ID}> hello`,
          channel: "C123",
          ts: "1712345.0001",
          event_ts: "1712345.0001",
          channel_type: "channel",
        },
      }),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
      },
    }).then((response) => {
      responseSettled = true;
      return response;
    });

    await queueSendEntered;
    expect(responseSettled).toBe(false);
    expect(queue.queuedMessages()).toEqual([
      {
        schemaVersion: 2,
        conversationId: "slack:C123:1712345.0001",
      },
    ]);
    expect(waitUntil.pendingCount()).toBe(0);

    finishQueueSend.resolve();
    await expect(responsePromise).resolves.toMatchObject({ status: 200 });
  });

  it("routes explicit mentions from other Slack bots", async () => {
    const state = createMemoryState();
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const slackAdapter = createSlackAdapter();

    const response = await handleSlackWebhook({
      request: client.event({
        team_id: "T123",
        type: "event_callback",
        event: {
          type: "message",
          subtype: "bot_message",
          bot_id: "B_DEPLOY",
          username: "Deploy Bot",
          text: `<@${BOT_USER_ID}> production deploy failed`,
          channel: "C123",
          ts: "1712345.0002",
          event_ts: "1712345.0002",
          channel_type: "channel",
        },
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
    expect(waitUntil.pendingCount()).toBe(0);
    expect(queue.queuedMessages()).toEqual([
      {
        schemaVersion: 2,
        conversationId: "slack:C123:1712345.0002",
      },
    ]);
  });

  it("removes only the disconnected provider account identity", async () => {
    const slackIdentity = await upsertIdentity(getSqlExecutor(), {
      kind: "user",
      provider: "slack",
      providerTenantId: "T123",
      providerSubjectId: "U123",
      email: "alice@example.com",
      emailVerified: true,
    });
    if (!slackIdentity.userId) throw new Error("missing test user");
    await upsertLinkedIdentity(getSqlExecutor(), slackIdentity.userId, {
      kind: "user",
      provider: "github",
      providerSubjectId: "github-1",
      handle: "alice-one",
    });
    await upsertLinkedIdentity(getSqlExecutor(), slackIdentity.userId, {
      kind: "user",
      provider: "github",
      providerSubjectId: "github-2",
      handle: "alice-two",
    });

    const state = createMemoryState();
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const userTokenStore = createTokenStore({
      get: vi.fn(async () => ({
        accessToken: "github-access-token",
        refreshToken: "github-refresh-token",
        account: { id: "github-1" },
      })),
    });
    const params = new URLSearchParams({
      payload: JSON.stringify(interactiveDisconnectPayload("github")),
    });

    const response = await handleSlackWebhook({
      request: client.form(params),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: createSlackAdapter,
        queue: createConversationWorkQueueTestAdapter(),
        runtime: createNoopSlackWebhookRuntime(),
        state,
        getUserTokenStore: () => userTokenStore,
      },
    });

    expect(response.status).toBe(200);
    await waitUntil.flush();
    expect(userTokenStore.delete).toHaveBeenCalledWith("U123", "github");
    await expect(
      getSqlExecutor()
        .db()
        .select({ subjectId: juniorIdentities.providerSubjectId })
        .from(juniorIdentities)
        .where(
          and(
            eq(juniorIdentities.userId, slackIdentity.userId),
            eq(juniorIdentities.provider, "github"),
          ),
        ),
    ).resolves.toEqual([{ subjectId: "github-2" }]);
  });

  it("refreshes App Home after disconnect unlink failure", async () => {
    const state = createMemoryState();
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const workspaceTeamIds: Array<string | undefined> = [];
    const deleteToken = vi.fn(async () => {
      workspaceTeamIds.push(getWorkspaceTeamId());
      throw new Error("token store unavailable");
    });
    const userTokenStore = createTokenStore({ delete: deleteToken });
    const slackAdapter = createSlackAdapter();
    const params = new URLSearchParams({
      payload: JSON.stringify(interactiveDisconnectPayload()),
    });

    const response = await handleSlackWebhook({
      request: client.form(params),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
        getUserTokenStore: () => userTokenStore,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(1);
    await waitUntil.flush();
    expect(deleteToken).toHaveBeenCalledWith("U123", "notion");
    expect(workspaceTeamIds).toEqual(["T123"]);
    expect(slackApiOutbox.homeViews()).toHaveLength(1);
  });

  it("does not unlink App Home credentials for synthetic unknown users", async () => {
    const state = createMemoryState();
    const client = createSlackWebhookTestClient({
      signingSecret: SIGNING_SECRET,
    });
    const waitUntil = client.waitUntil();
    const queue = createConversationWorkQueueTestAdapter();
    const deleteToken = vi.fn(async () => {});
    const userTokenStore = createTokenStore({ delete: deleteToken });
    const slackAdapter = createSlackAdapter();
    const params = new URLSearchParams({
      payload: JSON.stringify({
        ...interactiveDisconnectPayload(),
        user: {
          id: "unknown",
          team_id: "T123",
        },
      }),
    });

    const response = await handleSlackWebhook({
      request: client.form(params),
      waitUntil: waitUntil.fn,
      services: {
        getSlackAdapter: () => slackAdapter,
        queue,
        runtime: createNoopSlackWebhookRuntime(),
        state,
        getUserTokenStore: () => userTokenStore,
      },
    });

    expect(response.status).toBe(200);
    expect(queue.sentRecords()).toEqual([]);
    expect(waitUntil.pendingCount()).toBe(1);
    await waitUntil.flush();
    expect(deleteToken).not.toHaveBeenCalled();
    expect(slackApiOutbox.homeViews()).toHaveLength(0);
  });
});
