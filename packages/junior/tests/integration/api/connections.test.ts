import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { connectionListSchema } from "@/api/schema";
import {
  createUserTokenStore,
  issueProviderCredentialLease,
} from "@/chat/capabilities/factory";
import { legacyWebActorUserId } from "@/chat/conversations/legacy-web-actor-id";
import { StateAdapterTokenStore } from "@/chat/credentials/state-adapter-token-store";
import { closeDb, getSqlExecutor } from "@/chat/db";
import {
  getMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorIdentities } from "@/db/schema";
import { getStateAdapter } from "@/chat/state/adapter";
import { GET as handleOAuthCallback } from "@/handlers/oauth-callback";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
import { readEvalOAuthRefreshTokens } from "../../msw/handlers/eval-oauth";
import { mswServer } from "../../msw/server";
import { createEvalOAuthAccountApp } from "../../fixtures/eval-oauth-account";
import {
  testWaitUntil,
  waitUntilCallbacks,
} from "../../fixtures/oauth-callback-after-harness";

const ORIGINAL_ENV = { ...process.env };

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`missing viewer for ${email}`);
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function evalOAuthIdentities() {
  return await getSqlExecutor()
    .db()
    .select({
      email: juniorIdentities.email,
      emailVerified: juniorIdentities.emailVerified,
      userId: juniorIdentities.userId,
    })
    .from(juniorIdentities)
    .where(
      and(
        eq(juniorIdentities.provider, "eval-oauth"),
        eq(juniorIdentities.providerSubjectId, "eval-account-1"),
      ),
    );
}

async function listConnections(app: ReturnType<typeof authenticatedApi>) {
  const response = await app.request("http://localhost/api/connections");
  expect(response.status).toBe(200);
  return connectionListSchema.parse(await response.json()).connections;
}

describe("connections API", () => {
  beforeEach(async () => {
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      EVAL_OAUTH_CLIENT_ID: "eval-oauth-client",
      EVAL_OAUTH_CLIENT_SECRET: "eval-oauth-secret",
      JUNIOR_BASE_URL: "https://junior.example.com",
    };
    await createEvalOAuthAccountApp({
      id: "eval-account-1",
      label: "person",
      verifiedEmails: ["personal@example.net", "Person@Example.com"],
    });
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await closeDb();
  });

  it("connects and disconnects a plugin account for the dashboard viewer", async () => {
    const app = authenticatedApi("person@example.com");
    const otherApp = authenticatedApi("other@example.com");

    expect(await listConnections(app)).toEqual([
      {
        connected: false,
        description: "Eval OAuth fixture",
        displayName: "Eval OAuth",
        provider: "eval-oauth",
        status: "disconnected",
      },
    ]);

    const startResponse = await app.request(
      "http://localhost/api/connections/eval-oauth",
      {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(startResponse.status).toBe(200);
    const { authorizationUrl } = (await startResponse.json()) as {
      authorizationUrl: string;
    };
    const authorization = new URL(authorizationUrl);
    expect(authorization.origin + authorization.pathname).toBe(
      "https://example.com/junior-eval-oauth/oauth/authorize",
    );
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      "https://junior.example.com/api/oauth/callback/eval-oauth",
    );
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();

    waitUntilCallbacks.length = 0;
    const callbackResponse = await handleOAuthCallback(
      new Request(
        `https://junior.example.com/api/oauth/callback/eval-oauth?state=${state}&code=eval-oauth-code`,
      ),
      "eval-oauth",
      testWaitUntil,
      {},
    );
    for (const callback of waitUntilCallbacks.splice(0)) {
      await callback();
    }
    expect(callbackResponse.status).toBe(200);
    expect(await callbackResponse.text()).not.toContain("return to Slack");
    expect(getCapturedSlackApiCalls("views.publish")).toEqual([]);

    expect(await listConnections(app)).toEqual([
      expect.objectContaining({ connected: true, provider: "eval-oauth" }),
    ]);
    expect(await listConnections(otherApp)).toEqual([
      expect.objectContaining({ connected: false, provider: "eval-oauth" }),
    ]);
    const viewer = await resolveViewerUser("person@example.com");
    expect(await evalOAuthIdentities()).toEqual([
      {
        email: "person@example.com",
        emailVerified: true,
        userId: viewer?.id,
      },
    ]);
    const storedTokens = await createUserTokenStore().get(
      viewer!.id,
      "eval-oauth",
    );
    expect(storedTokens?.account).toEqual({
      id: "eval-account-1",
      label: "person",
    });

    const disconnectResponse = await app.request(
      "http://localhost/api/connections/eval-oauth",
      { method: "DELETE" },
    );
    expect(disconnectResponse.status).toBe(200);
    expect(await disconnectResponse.json()).toEqual({ disconnected: true });
    expect(await listConnections(app)).toEqual([
      expect.objectContaining({ connected: false, provider: "eval-oauth" }),
    ]);
    expect(await evalOAuthIdentities()).toEqual([]);
  });

  it("keeps a connection saved under the legacy web Actor id", async () => {
    const app = authenticatedApi("person@example.com");
    const viewer = await resolveViewerUser("person@example.com");
    const legacyUserId = legacyWebActorUserId("person@example.com");
    // Read the raw keys: the runtime store moves legacy tokens on read.
    const rawStore = new StateAdapterTokenStore(getStateAdapter());
    await rawStore.transition(legacyUserId, "eval-oauth", {
      type: "connect",
      tokens: {
        accessToken: "legacy-access",
        account: { id: "eval-account-1", label: "person" },
        refreshToken: "legacy-refresh",
        scope: "read",
      },
    });

    expect(await listConnections(app)).toEqual([
      expect.objectContaining({
        account: { label: "person" },
        connected: true,
        provider: "eval-oauth",
      }),
    ]);
    expect(await rawStore.get(legacyUserId, "eval-oauth")).toBeUndefined();
    expect(await rawStore.get(viewer!.id, "eval-oauth")).toMatchObject({
      accessToken: "legacy-access",
    });

    // An old instance in a rolling deploy can save legacy keys again.
    await rawStore.transition(legacyUserId, "eval-oauth", {
      type: "connect",
      tokens: {
        accessToken: "old-instance-access",
        refreshToken: "old-instance-refresh",
        scope: "read",
      },
    });
    await putMcpStoredOAuthCredentials(legacyUserId, "eval-oauth", {
      tokens: { access_token: "legacy-mcp-access", token_type: "Bearer" },
    });

    const disconnectResponse = await app.request(
      "http://localhost/api/connections/eval-oauth",
      { method: "DELETE" },
    );
    expect(disconnectResponse.status).toBe(200);
    expect(await listConnections(app)).toEqual([
      expect.objectContaining({ connected: false, provider: "eval-oauth" }),
    ]);
    expect(await rawStore.get(legacyUserId, "eval-oauth")).toBeUndefined();
    expect(
      await getMcpStoredOAuthCredentials(viewer!.id, "eval-oauth"),
    ).toBeUndefined();
  });

  it("keeps a disconnect when a token refresh finishes after it", async () => {
    const app = authenticatedApi("person@example.com");
    const viewer = await resolveViewerUser("person@example.com");
    await createUserTokenStore().transition(viewer!.id, "eval-oauth", {
      type: "connect",
      tokens: {
        accessToken: "stale-access",
        expiresAt: Date.now() - 1,
        refreshToken: "eval-oauth-refresh-token",
        scope: "read",
      },
    });
    let enterRefresh!: () => void;
    let finishRefresh!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      enterRefresh = resolve;
    });
    const refreshGate = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    mswServer.use(
      http.post(
        "https://example.com/junior-eval-oauth/oauth/token",
        async () => {
          enterRefresh();
          await refreshGate;
          return HttpResponse.json({
            access_token: "refreshed-access",
            expires_in: 3600,
            refresh_token: "rotated-refresh",
            scope: "read",
            token_type: "Bearer",
          });
        },
        { once: true },
      ),
    );

    const lease = issueProviderCredentialLease({
      context: { actor: { type: "user", userId: viewer!.id } },
      provider: "eval-oauth",
      reason: "test:refresh-race",
    });
    await refreshStarted;
    const disconnectResponse = await app.request(
      "http://localhost/api/connections/eval-oauth",
      { method: "DELETE" },
    );
    expect(disconnectResponse.status).toBe(200);
    finishRefresh();

    await expect(lease).rejects.toThrow(
      "Your eval-oauth connection changed during token refresh. Try again.",
    );
    expect(
      await createUserTokenStore().read(viewer!.id, "eval-oauth"),
    ).toBeUndefined();
    expect(await listConnections(app)).toEqual([
      expect.objectContaining({ connected: false, status: "disconnected" }),
    ]);
  });

  it("shows a connection as expired after the provider rejects its refresh", async () => {
    const app = authenticatedApi("person@example.com");
    const viewer = await resolveViewerUser("person@example.com");
    await createUserTokenStore().transition(viewer!.id, "eval-oauth", {
      type: "connect",
      tokens: {
        accessToken: "stale-access",
        account: { id: "eval-account-1", label: "person" },
        expiresAt: Date.now() - 1,
        refreshToken: "revoked-refresh",
        scope: "read",
      },
    });

    await expect(
      issueProviderCredentialLease({
        context: { actor: { type: "user", userId: viewer!.id } },
        provider: "eval-oauth",
        reason: "test:refresh-rejected",
      }),
    ).rejects.toThrow(
      "Your eval-oauth connection has expired. Reconnect it to continue.",
    );
    expect(await listConnections(app)).toEqual([
      expect.objectContaining({
        account: { label: "person" },
        connected: false,
        status: "expired",
      }),
    ]);
    // The expired grant keeps no secrets, and a later use asks to reconnect
    // without another refresh.
    expect(await createUserTokenStore().read(viewer!.id, "eval-oauth")).toEqual(
      {
        account: { id: "eval-account-1", label: "person" },
        status: "expired",
      },
    );
    await expect(
      issueProviderCredentialLease({
        context: { actor: { type: "user", userId: viewer!.id } },
        provider: "eval-oauth",
        reason: "test:expired",
      }),
    ).rejects.toThrow("has expired");
    expect(readEvalOAuthRefreshTokens()).toEqual(["revoked-refresh"]);

    const disconnectResponse = await app.request(
      "http://localhost/api/connections/eval-oauth",
      { method: "DELETE" },
    );
    expect(disconnectResponse.status).toBe(200);
    expect(await listConnections(app)).toEqual([
      expect.objectContaining({ status: "disconnected" }),
    ]);
  });

  it("rejects providers without user OAuth", async () => {
    const response = await authenticatedApi("person@example.com").request(
      "http://localhost/api/connections/missing",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
  });
});
