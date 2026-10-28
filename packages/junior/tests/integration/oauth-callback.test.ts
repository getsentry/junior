import path from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../fixtures/plugin-app";
import {
  testWaitUntil,
  waitUntilCallbacks,
} from "../fixtures/oauth-callback-after-harness";
import { mswServer } from "../msw/server";

const ORIGINAL_ENV = { ...process.env };
const EVAL_OAUTH_PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../fixtures/plugins/eval-oauth",
);

type StateAdapterModule = typeof import("@/chat/state/adapter");
type CapabilitiesFactoryModule = typeof import("@/chat/capabilities/factory");
type OAuthCallbackModule = typeof import("@/handlers/oauth-callback");

let stateAdapterModule: StateAdapterModule;
let capabilitiesFactoryModule: CapabilitiesFactoryModule;
let oauthCallbackModule: OAuthCallbackModule;
let pluginApp: PluginAppFixture | undefined;

describe("oauth callback integration", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_SECRET: "test-local-oauth-secret",
    };
    pluginApp = await createPluginAppFixture([EVAL_OAUTH_PLUGIN_ROOT]);
    vi.resetModules();
    stateAdapterModule = await import("@/chat/state/adapter");
    capabilitiesFactoryModule = await import("@/chat/capabilities/factory");
    oauthCallbackModule = await import("@/handlers/oauth-callback");
    await stateAdapterModule.disconnectStateAdapter();
    await stateAdapterModule.getStateAdapter().connect();
  }, 45_000);

  afterEach(async () => {
    await stateAdapterModule?.disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  }, 45_000);

  it("publishes the App Home of the Slack person after the callback", async () => {
    await stateAdapterModule
      .getStateAdapter()
      .set("oauth-state:eval-oauth-state", {
        userId: "U123",
        provider: "eval-oauth",
      });

    waitUntilCallbacks.length = 0;
    const response = await oauthCallbackModule.GET(
      new Request(
        "https://junior.example.com/api/oauth/callback/eval-oauth?state=eval-oauth-state&code=eval-oauth-code",
      ),
      "eval-oauth",
      testWaitUntil,
      {},
    );
    for (const callback of waitUntilCallbacks.splice(0)) {
      await callback();
    }

    expect(response.status).toBe(200);
    await expect(
      capabilitiesFactoryModule
        .createUserTokenStore()
        .get("U123", "eval-oauth"),
    ).resolves.toEqual(
      expect.objectContaining({ accessToken: "eval-oauth-access-token" }),
    );
    expect(getCapturedSlackApiCalls("views.publish")).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({
          user_id: "U123",
          view: expect.objectContaining({
            type: "home",
          }),
        }),
      }),
    ]);
  }, 20_000);

  it("stores and syncs local credentials through the real loopback callback", async () => {
    let syncedCredential: unknown;
    mswServer.use(
      http.post(
        "http://127.0.0.1:3000/api/internal/local-oauth-credentials",
        async ({ request }) => {
          syncedCredential = await request.json();
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    const { startLocalOAuthCallbackServer } =
      await import("@/chat/local/oauth-callback-server");
    const { createLocalOAuthState } = await import("@/chat/local/oauth-relay");
    const conversationId = "local:oauth:loopback";
    const callback = await startLocalOAuthCallbackServer();

    try {
      const state = await createLocalOAuthState(callback.port);
      const authorizationUrl = `https://example.com/authorize?state=${encodeURIComponent(state)}`;
      await stateAdapterModule.getStateAdapter().set(`oauth-state:${state}`, {
        userId: "local-cli",
        provider: "eval-oauth",
        destination: {
          platform: "local",
          conversationId,
        },
        source: createLocalSource(conversationId),
        scope: "read",
      });
      callback.beginAuthorization(authorizationUrl);
      const response = await fetch(
        `http://127.0.0.1:${callback.port}/api/oauth/callback/eval-oauth?state=${encodeURIComponent(state)}&code=eval-oauth-code&jr_local_relay=complete`,
      );

      expect(response.status).toBe(200);
      await expect(callback.waitForAuthorization()).resolves.toBeUndefined();
      expect(getCapturedSlackApiCalls("views.publish")).toEqual([]);
      await expect(
        capabilitiesFactoryModule
          .createUserTokenStore()
          .get("local-cli", "eval-oauth"),
      ).resolves.toEqual(
        expect.objectContaining({ accessToken: "eval-oauth-access-token" }),
      );
      expect(syncedCredential).toEqual({
        createdAtMs: expect.any(Number),
        provider: "eval-oauth",
        tokens: expect.objectContaining({
          accessToken: "eval-oauth-access-token",
        }),
      });
    } finally {
      await callback.close();
    }
  }, 20_000);
});
