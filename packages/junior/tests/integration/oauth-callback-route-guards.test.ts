import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_OAUTH_CODE,
  EVAL_OAUTH_PROVIDER,
  createOauthCallbackRouteFixture,
} from "../fixtures/oauth-callback-route";

let testbed: Awaited<ReturnType<typeof createOauthCallbackRouteFixture>>;

describe("oauth callback route guards", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackRouteFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("returns styled HTML 404 for unknown providers", async () => {
    const response = await testbed.runCallbackUrl({
      provider: "unknown",
      url: "https://junior.example.com/api/oauth/callback/unknown?code=abc&state=xyz",
    });

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("Unknown provider");
  });

  it("returns styled HTML 400 when code or state is missing", async () => {
    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/${EVAL_OAUTH_PROVIDER}`,
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("missing required parameters");
  });

  it("returns styled HTML 400 for expired state", async () => {
    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/${EVAL_OAUTH_PROVIDER}?code=${EVAL_OAUTH_CODE}&state=missing-state`,
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("expired");
    expect(body).toContain("connect your");
    expect(body).toContain("account again");
  });

  it("returns styled HTML 400 for provider mismatch", async () => {
    await testbed.storeOAuthState("provider-mismatch", {
      provider: "different-provider",
    });

    const response = await testbed.runRoute({
      state: "provider-mismatch",
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("mismatch");
  });
});
