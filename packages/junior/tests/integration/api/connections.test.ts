import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { connectionListSchema } from "@/api/schema";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { webActorFromEmail } from "@/chat/conversations/web-input";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorIdentities } from "@/db/schema";
import { GET as handleOAuthCallback } from "@/handlers/oauth-callback";
import {
  getCapturedSlackApiCalls,
  resetSlackApiMockState,
} from "../../msw/handlers/slack-api";
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
      webActorFromEmail("person@example.com").userId,
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

  it("rejects providers without user OAuth", async () => {
    const response = await authenticatedApi("person@example.com").request(
      "http://localhost/api/connections/missing",
      { method: "DELETE" },
    );

    expect(response.status).toBe(404);
  });
});
