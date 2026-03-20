import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetPluginRegistryForTests,
  setAdditionalPluginRootsForTests,
} from "@/chat/plugins/registry";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state";
import { runOauthCallbackRoute } from "../fixtures/oauth-callback-harness";
import { getCapturedSlackApiCalls } from "../msw/handlers/slack-api";

const ORIGINAL_ENV = { ...process.env };

describe("oauth callback slack integration", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
      JUNIOR_BASE_URL: "https://junior.example.com",
    };
    resetPluginRegistryForTests();
    setAdditionalPluginRootsForTests([
      path.resolve(process.cwd(), "evals/plugins/eval-oauth"),
    ]);
    await disconnectStateAdapter();
    await getStateAdapter().connect();
  });

  afterEach(async () => {
    resetPluginRegistryForTests();
    await disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("publishes app home through the Slack MSW harness after generic OAuth callback", async () => {
    await getStateAdapter().set("oauth-state:eval-oauth-state", {
      userId: "U123",
      provider: "eval-oauth",
    });

    const response = await runOauthCallbackRoute({
      provider: "eval-oauth",
      state: "eval-oauth-state",
      code: "eval-oauth-code",
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
  });
});
