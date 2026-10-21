import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getSqlExecutor } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { getStateAdapter } from "@/chat/state/adapter";
import { juniorIdentities } from "@/db/schema";
import { GET as handleOAuthCallback } from "@/handlers/oauth-callback";
import { createEvalOAuthAccountApp } from "../fixtures/eval-oauth-account";
import { testWaitUntil } from "../fixtures/oauth-callback-after-harness";
import { usersInfoOk } from "../fixtures/slack/factories/api";
import {
  queueSlackApiResponse,
  resetSlackApiMockState,
} from "../msw/handlers/slack-api";

const ORIGINAL_ENV = { ...process.env };

describe("oauth identity link", () => {
  beforeEach(() => {
    resetSlackApiMockState();
    process.env = {
      ...ORIGINAL_ENV,
      EVAL_OAUTH_CLIENT_ID: "eval-oauth-client",
      EVAL_OAUTH_CLIENT_SECRET: "eval-oauth-secret",
      JUNIOR_BASE_URL: "https://junior.example.com",
    };
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await closeDb();
  });

  it("links a Slack connection through a provider-verified email when Slack has no email", async () => {
    await createEvalOAuthAccountApp({
      id: "eval-account-1",
      verifiedEmails: ["personal@example.net", "person@example.com"],
    });
    const person = await resolveViewerUser("person@example.com");
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U0TEST", email: "" }),
    });
    await getStateAdapter().set("oauth-state:eval-oauth-email-link", {
      actor: { platform: "slack", teamId: "T0TEST", userId: "U0TEST" },
      provider: "eval-oauth",
      userId: "U0TEST",
    });

    const response = await handleOAuthCallback(
      new Request(
        "https://junior.example.com/api/oauth/callback/eval-oauth?state=eval-oauth-email-link&code=eval-oauth-code",
      ),
      "eval-oauth",
      testWaitUntil,
      {},
    );

    expect(response.status).toBe(200);
    const identities = await getSqlExecutor()
      .db()
      .select({
        email: juniorIdentities.email,
        provider: juniorIdentities.provider,
        userId: juniorIdentities.userId,
      })
      .from(juniorIdentities);
    expect(identities).toEqual(
      expect.arrayContaining([
        {
          email: "person@example.com",
          provider: "eval-oauth",
          userId: person?.id,
        },
        { email: null, provider: "slack", userId: null },
      ]),
    );
  });
});
