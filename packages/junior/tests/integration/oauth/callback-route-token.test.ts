import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_OAUTH_PROVIDER,
  createOauthCallbackRouteFixture,
} from "../../fixtures/oauth/callback-route";
import { queueEvalOAuthTokenResponse } from "../../msw/handlers/eval-oauth";

let testbed: Awaited<ReturnType<typeof createOauthCallbackRouteFixture>>;

describe("oauth callback route token exchange", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackRouteFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("exchanges code for tokens, stores them, and consumes callback state", async () => {
    await testbed.storeOAuthState("exchange-state", {
      userId: "U456",
    });

    const response = await testbed.runRoute({
      provider: EVAL_OAUTH_PROVIDER,
      state: "exchange-state",
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("account connected");

    expect(await testbed.getStoredToken({ userId: "U456" })).toEqual(
      expect.objectContaining({
        accessToken: "eval-oauth-access-token",
        refreshToken: "eval-oauth-refresh-token",
        scope: "read",
        expiresAt: expect.any(Number),
      }),
    );
    expect(await testbed.getOAuthState("exchange-state")).toBeFalsy();
  });

  it("shows pending-message status in the success page", async () => {
    await testbed.storeOAuthState("pending-message-state", {
      pendingMessage: "list my issues",
    });

    const response = await testbed.runRoute({
      state: "pending-message-state",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("being processed in Slack");
  });

  it("rejects callback grants whose explicit scope is missing required access", async () => {
    await testbed.storeOAuthState("missing-scope-state", {
      userId: "U789",
    });
    queueEvalOAuthTokenResponse({
      body: {
        access_token: "scope-access",
        refresh_token: "scope-refresh",
        expires_in: 3600,
        scope: "write",
      },
    });

    const response = await testbed.runRoute({
      state: "missing-scope-state",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "did not grant the access Junior requires",
    );
    expect(await testbed.getStoredToken({ userId: "U789" })).toBeUndefined();
  });

  it("returns styled HTML 500 when token exchange fails", async () => {
    await testbed.storeOAuthState("failed-exchange-state", {
      userId: "U999",
    });

    const response = await testbed.runRoute({
      state: "failed-exchange-state",
      code: "bad-code",
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("failed");
    expect(await testbed.getStoredToken({ userId: "U999" })).toBeUndefined();
  });

  it("returns styled HTML 500 when client credentials are missing", async () => {
    await testbed.storeOAuthState("missing-credentials-state");
    delete process.env.EVAL_OAUTH_CLIENT_ID;
    delete process.env.EVAL_OAUTH_CLIENT_SECRET;

    const response = await testbed.runRoute({
      state: "missing-credentials-state",
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("credentials");
  });
});
