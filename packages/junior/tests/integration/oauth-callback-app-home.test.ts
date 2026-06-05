import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVAL_OAUTH_PROVIDER,
  createOauthCallbackSlackFixture,
} from "../fixtures/oauth-callback-slack";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

let testbed: Awaited<ReturnType<typeof createOauthCallbackSlackFixture>>;

describe("oauth callback app home", () => {
  beforeEach(async () => {
    testbed = await createOauthCallbackSlackFixture();
  }, 45_000);

  afterEach(async () => {
    await testbed.cleanup();
  }, 45_000);

  it("publishes app home through the Slack MSW harness after generic OAuth callback", async () => {
    await testbed.storeOAuthState("eval-oauth-state");

    const response = await testbed.runRoute({
      provider: EVAL_OAUTH_PROVIDER,
      state: "eval-oauth-state",
    });

    expect(response.status).toBe(200);
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
});
