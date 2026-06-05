import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_OAUTH_PROVIDER,
  createOauthCallbackRouteFixture,
} from "../fixtures/oauth-callback-route";

let testbed: Awaited<ReturnType<typeof createOauthCallbackRouteFixture>>;

describe("oauth callback route provider errors", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackRouteFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("deletes callback state and returns declined HTML when the user denies authorization", async () => {
    await testbed.storeOAuthState("denied-state");

    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/${EVAL_OAUTH_PROVIDER}?error=access_denied&state=denied-state`,
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).toContain("declined");
    expect(body).toContain("ask Junior to connect your");
    expect(body).toContain("account again if you change your mind");
    expect(body).not.toContain("auth command");
    expect(await testbed.getOAuthState("denied-state")).toBeFalsy();
  });

  it("escapes provider-returned error text in the HTML response", async () => {
    const response = await testbed.runCallbackUrl({
      url: `https://junior.example.com/api/oauth/callback/${EVAL_OAUTH_PROVIDER}?error=%3Cscript%3Ealert(1)%3C/script%3E&state=xss-state`,
    });

    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});
