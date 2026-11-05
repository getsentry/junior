import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createConversationId,
  recordWebConversationActivity,
  webActorFromUser,
} from "@/chat/conversations/web-input";
import {
  closeDb,
  getConversationEventStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import type { IdentityLinkedHookContext } from "@sentry/junior-plugin-api";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import {
  identityLinkRequestDedupeKey,
  requestIdentityLink,
} from "@/chat/identities/link-request";
import { readActorIdentity, resolveViewerUser } from "@/chat/plugins/viewer";
import { getReviewItem } from "@/chat/review-items/store";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  juniorConversationEvents,
  juniorConversations,
  juniorIdentities,
} from "@/db/schema";
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

  it("links a web connection to the identity that the viewer and message events use", async () => {
    await createEvalOAuthAccountApp({ id: "eval-account-web" });
    const actor = webActorFromUser({
      displayName: "Web Person",
      email: "Web.Person@Example.com",
      id: "web-person",
    });
    await getStateAdapter().set("oauth-state:eval-oauth-web-link", {
      actor,
      provider: "eval-oauth",
      userId: actor.userId,
    });

    const response = await handleOAuthCallback(
      new Request(
        "https://junior.example.com/api/oauth/callback/eval-oauth?state=eval-oauth-web-link&code=eval-oauth-code",
      ),
      "eval-oauth",
      testWaitUntil,
      {},
    );

    expect(response.status).toBe(200);
    const viewer = await readActorIdentity(actor);
    expect(viewer).toMatchObject({
      identity: {
        provider: "junior",
        providerSubjectId: "web.person@example.com",
      },
      user: { email: "web.person@example.com" },
    });
    const [linked] = await getSqlExecutor()
      .db()
      .select({ userId: juniorIdentities.userId })
      .from(juniorIdentities)
      .where(eq(juniorIdentities.provider, "eval-oauth"));
    expect(linked?.userId).toBe(viewer?.user?.id);

    const conversationId = createConversationId({
      actorEmail: actor.email!,
      idempotencyKey: "web-identity-link",
    });
    await recordWebConversationActivity({
      actor,
      conversationId,
      nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
    });
    await getConversationEventStore().append(conversationId, [
      {
        createdAtMs: Date.parse("2026-08-21T12:00:01.000Z"),
        data: {
          messageId: "web-identity-link-message",
          meta: {
            author: {
              email: actor.email,
              isBot: false,
              userId: actor.userId,
            },
          },
          role: "user",
          text: "hello from the dashboard",
          type: "message",
        },
        idempotencyKey: "message:web-identity-link-message",
      },
    ]);
    const [conversation] = await getSqlExecutor()
      .db()
      .select({ actorIdentityId: juniorConversations.actorIdentityId })
      .from(juniorConversations)
      .where(eq(juniorConversations.conversationId, conversationId));
    const [event] = await getSqlExecutor()
      .db()
      .select({ actorIdentityId: juniorConversationEvents.actorIdentityId })
      .from(juniorConversationEvents)
      .where(eq(juniorConversationEvents.conversationId, conversationId));
    expect(conversation?.actorIdentityId).toBe(viewer?.identity.id);
    expect(event?.actorIdentityId).toBe(viewer?.identity.id);
  });

  it("asks for a link without blocking, then closes the request and updates work when the account links", async () => {
    const linked: IdentityLinkedHookContext[] = [];
    await createEvalOAuthAccountApp(
      { id: "eval-account-request", handle: "person-handle" },
      "eval-oauth",
      { dashboard: true, identityLinked: (ctx) => void linked.push(ctx) },
    );
    const actor = webActorFromUser({
      displayName: "Web Person",
      email: "web.person@example.com",
      id: "web-person",
    });
    await resolveActorIdentityId(getSqlExecutor(), actor);
    const conversationId = createConversationId({
      actorEmail: actor.email!,
      idempotencyKey: "identity-link-request",
    });
    await recordWebConversationActivity({
      actor,
      conversationId,
      nowMs: Date.parse("2026-08-21T12:00:00.000Z"),
    });
    const requester = await readActorIdentity(actor);
    const shown: string[] = [];
    const show = async (itemId: string) => void shown.push(itemId);

    const request = {
      conversationId,
      provider: "eval-oauth",
      reason: "Junior opened a pull request for you.",
      requester,
      show,
    };
    await expect(requestIdentityLink(request)).resolves.toEqual({
      status: "requested",
    });
    // A repeat keeps one open request.
    await requestIdentityLink(request);
    const [itemId] = shown;
    expect(new Set(shown)).toEqual(new Set([itemId]));
    const item = await getReviewItem(getDb(), itemId!);
    expect(item).toMatchObject({
      assignees: [{ userId: requester?.user?.id }],
      body: "Junior opened a pull request for you.\n\n[Connect your Eval OAuth account](https://junior.example.com/settings/connections)",
      dedupeKey: identityLinkRequestDedupeKey(
        "eval-oauth",
        requester!.user!.id,
      ),
      kind: "notice",
      status: "open",
      title: "Link your Eval OAuth account",
    });

    await getStateAdapter().set("oauth-state:eval-oauth-request-link", {
      actor,
      provider: "eval-oauth",
      userId: actor.userId,
    });
    const response = await handleOAuthCallback(
      new Request(
        "https://junior.example.com/api/oauth/callback/eval-oauth?state=eval-oauth-request-link&code=eval-oauth-code",
      ),
      "eval-oauth",
      testWaitUntil,
      { showReviewItem: show },
    );

    expect(response.status).toBe(200);
    expect(await getReviewItem(getDb(), itemId!)).toMatchObject({
      closeReason: "Linked the account.",
      status: "done",
    });
    expect(shown.at(-1)).toBe(itemId);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      identity: { handle: "person-handle", provider: "eval-oauth" },
      user: {
        id: requester?.user?.id,
        identities: expect.arrayContaining([
          expect.objectContaining({ provider: "eval-oauth" }),
        ]),
      },
    });
    // The User has the account now, so a later request adds nothing.
    await expect(
      requestIdentityLink({
        ...request,
        requester: await readActorIdentity(actor),
      }),
    ).resolves.toEqual({ status: "skipped" });
  });

  it("does not link a plugin OAuth account as a native Google identity", async () => {
    await createEvalOAuthAccountApp(
      { id: "google-sub-1", verifiedEmails: ["person@example.com"] },
      "google",
    );
    await resolveViewerUser("person@example.com");
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U0TEST", email: "person@example.com" }),
    });
    await getStateAdapter().set("oauth-state:google-plugin-link", {
      actor: { platform: "slack", teamId: "T0TEST", userId: "U0TEST" },
      provider: "google",
      userId: "U0TEST",
    });

    const response = await handleOAuthCallback(
      new Request(
        "https://junior.example.com/api/oauth/callback/google?state=google-plugin-link&code=eval-oauth-code",
      ),
      "google",
      testWaitUntil,
      {},
    );

    expect(response.status).toBe(200);
    const providers = await getSqlExecutor()
      .db()
      .select({ provider: juniorIdentities.provider })
      .from(juniorIdentities);
    expect(providers).not.toContainEqual({ provider: "google" });
  });
});
