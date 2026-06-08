import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../../fixtures/plugin-app";
import {
  createConversationWorkQueueTestAdapter,
  createNoopSlackWebhookRuntime,
} from "../../fixtures/conversation-work";
import { slackApiOutbox } from "../../fixtures/slack-api-outbox";
import { createSlackWebhookTestClient } from "../../fixtures/slack/webhook-client";
import { resetSlackApiMockState } from "../../msw/handlers/slack-api";

const SIGNING_SECRET = "test-signing-secret";
const BOT_USER_ID = "U_BOT";
const ORIGINAL_ENV = { ...process.env };
const EVAL_OAUTH_PROVIDER = "eval-oauth";
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../../fixtures/plugins/eval-oauth",
);

async function loadSlackWebhookModules() {
  vi.resetModules();
  const [
    { handleSlackWebhook },
    { createJuniorSlackAdapter },
    { createUserTokenStore },
    { disconnectStateAdapter, getStateAdapter },
  ] = await Promise.all([
    import("@/chat/ingress/slack-webhook"),
    import("@/chat/slack/adapter"),
    import("@/chat/capabilities/factory"),
    import("@/chat/state/adapter"),
  ]);

  await disconnectStateAdapter();
  const state = getStateAdapter();
  await state.connect();

  return {
    createJuniorSlackAdapter,
    createUserTokenStore,
    getStateAdapter,
    handleSlackWebhook,
    state,
  };
}

function slashCommandRequest(text: string): Request {
  return createSlackWebhookTestClient({ signingSecret: SIGNING_SECRET }).form(
    new URLSearchParams({
      command: "/team",
      team_id: "T123",
      channel_id: "C123",
      user_id: "U123",
      user_name: "alice",
      text,
      trigger_id: "trigger-123",
    }),
  );
}

async function createSlashCommandHarness() {
  const loaded = await loadSlackWebhookModules();
  const waitUntil = createSlackWebhookTestClient({
    signingSecret: SIGNING_SECRET,
  }).waitUntil();

  return {
    ...loaded,
    waitUntil,
    async run(text: string): Promise<Response> {
      return await loaded.handleSlackWebhook({
        request: slashCommandRequest(text),
        waitUntil: waitUntil.fn,
        services: {
          getSlackAdapter: () =>
            loaded.createJuniorSlackAdapter({
              botToken: "xoxb-test-token",
              botUserId: BOT_USER_ID,
              signingSecret: SIGNING_SECRET,
            }),
          queue: createConversationWorkQueueTestAdapter(),
          runtime: createNoopSlackWebhookRuntime(),
          state: loaded.state,
        },
      });
    },
  };
}

describe("Slack behavior: slash commands", () => {
  let pluginApp: PluginAppFixture | undefined;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      EVAL_OAUTH_CLIENT_ID: "eval-oauth-client",
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_SLASH_COMMAND: "/team",
      JUNIOR_STATE_ADAPTER: "memory",
      SLACK_BOT_TOKEN: "xoxb-test-token",
    };
    resetSlackApiMockState();
    pluginApp = await createPluginAppFixture([EVAL_OAUTH_PLUGIN_ROOT]);
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    resetSlackApiMockState();
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("acknowledges usage errors and posts the configured command syntax", async () => {
    const harness = await createSlashCommandHarness();
    const response = await harness.run("help");

    expect(response.status).toBe(200);
    expect(harness.waitUntil.pendingCount()).toBe(1);
    await harness.waitUntil.flush();

    expect(slackApiOutbox.calls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: "Usage: `/team link <provider>` or `/team unlink <provider>`",
        }),
      }),
    ]);
  });

  it("starts OAuth linking through Slack private delivery and persisted state", async () => {
    const harness = await createSlashCommandHarness();
    const response = await harness.run(`link ${EVAL_OAUTH_PROVIDER}`);

    expect(response.status).toBe(200);
    expect(harness.waitUntil.pendingCount()).toBe(1);
    await harness.waitUntil.flush();

    const [delivery] = slackApiOutbox.calls("chat.postEphemeral");
    expect(delivery).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: expect.stringContaining(
            `Click here to link your Eval-oauth account`,
          ),
        }),
      }),
    );
    const text = delivery?.params.text;
    if (typeof text !== "string") {
      throw new Error("expected OAuth delivery text");
    }
    const authUrl = text.match(/^<([^|]+)\|/)?.[1];
    if (!authUrl) {
      throw new Error("expected Slack link-formatted OAuth URL");
    }
    const stateValue = new URL(authUrl).searchParams.get("state");
    expect(stateValue).toBeTruthy();
    await expect(
      harness.getStateAdapter().get(`oauth-state:${stateValue}`),
    ).resolves.toMatchObject({
      userId: "U123",
      provider: EVAL_OAUTH_PROVIDER,
      channelId: "C123",
      scope: "read",
    });
  });

  it("unlinks OAuth credentials from the real token store", async () => {
    const harness = await createSlashCommandHarness();
    const tokenStore = harness.createUserTokenStore();
    await tokenStore.set("U123", EVAL_OAUTH_PROVIDER, {
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      scope: "read",
    });
    const response = await harness.run(`unlink ${EVAL_OAUTH_PROVIDER}`);

    expect(response.status).toBe(200);
    expect(harness.waitUntil.pendingCount()).toBe(1);
    await harness.waitUntil.flush();

    await expect(tokenStore.get("U123", EVAL_OAUTH_PROVIDER)).resolves.toBe(
      undefined,
    );
    expect(slackApiOutbox.calls("chat.postEphemeral")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          channel: "C123",
          user: "U123",
          text: "Your Eval-oauth account has been unlinked.",
        }),
      }),
    ]);
  });
});
