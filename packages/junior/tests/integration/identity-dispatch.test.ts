import {
  defineJuniorPlugin,
  type HeartbeatHookContext,
  type RouteRegistrationHookContext,
} from "@sentry/junior-plugin-api";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import { readConversationAccessFromSql } from "@/api/conversations/access";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { upsertIdentity, upsertLinkedIdentity } from "@/chat/identities/sql";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { getConversationWorkState } from "@/chat/task-execution/store";
import { usersInfoOk } from "../fixtures/slack/factories/api";
import { createWaitUntilCollector } from "../fixtures/wait-until";
import {
  createConversationWorkQueueTestAdapter,
  type ConversationWorkQueueTestAdapter,
} from "../fixtures/conversation-work";
import {
  getCapturedSlackApiCalls,
  queueSlackApiResponse,
} from "../msw/handlers/slack-api";

/**
 * Seed one Slack member and, optionally, a provider account linked by OAuth.
 * Return the User id.
 */
async function seedSlackUser(args: {
  email: string;
  linked?: { handle?: string; provider: string; subjectId: string };
  slackUserId: string;
}): Promise<string> {
  const slack = await upsertIdentity(getSqlExecutor(), {
    kind: "user",
    provider: "slack",
    providerTenantId: "T123",
    providerSubjectId: args.slackUserId,
    email: args.email,
    emailVerified: true,
  });
  if (args.linked) {
    await upsertLinkedIdentity(getSqlExecutor(), slack.userId!, {
      kind: "user",
      provider: args.linked.provider,
      providerSubjectId: args.linked.subjectId,
      ...(args.linked.handle ? { handle: args.linked.handle } : undefined),
    });
  }
  return slack.userId!;
}

/** Read the Conversation and the first Message that an Identity dispatch made. */
async function readStartedConversation(conversationId: string) {
  const conversation = await getConversationStore().get({ conversationId });
  const work = await getConversationWorkState({ conversationId });
  return {
    actor: conversation?.actor,
    destination: conversation?.destination,
    message: work?.execution.pendingMessages[0]?.input,
    visibility: conversation?.visibility,
  };
}

describe("plugin Identity dispatch", () => {
  let agent: RouteRegistrationHookContext["agent"];
  let googleAgent: RouteRegistrationHookContext["agent"];
  let onGoogleHeartbeat: (
    agent: HeartbeatHookContext["agent"],
  ) => Promise<void> = async () => {};
  let app: Awaited<ReturnType<typeof createApp>>;
  let queue: ConversationWorkQueueTestAdapter;
  const waitUntil = createWaitUntilCollector();

  async function startApp(allowedDomains?: string[]): Promise<void> {
    await disconnectStateAdapter();
    queue = createConversationWorkQueueTestAdapter();
    app = await createApp({
      ...(allowedDomains ? { allowedDomains } : undefined),
      conversationWorkQueue: () => queue,
      waitUntil: waitUntil.fn,
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: { name: "demo", displayName: "Demo", description: "Demo" },
          hooks: {
            routes(ctx) {
              agent = ctx.agent;
              return [];
            },
          },
        }),
        // A plugin that shares a native provider name.
        defineJuniorPlugin({
          manifest: {
            name: "google",
            displayName: "Google",
            description: "Google",
          },
          hooks: {
            async heartbeat(ctx) {
              await onGoogleHeartbeat(ctx.agent);
            },
            routes(ctx) {
              googleAgent = ctx.agent;
              return [];
            },
          },
        }),
      ]),
    });
  }

  beforeEach(async () => {
    process.env.JUNIOR_SCHEDULER_SECRET = "heartbeat-secret";
    await startApp();
  });

  it("starts one public web Conversation for a linked current Slack member", async () => {
    const userId = await seedSlackUser({
      email: "requester@example.com",
      linked: { provider: "demo", subjectId: "1001" },
      slackUserId: "U123",
    });
    const request = {
      idempotencyKey: "delivery-1",
      input: "Look at demo issue 7.",
      subjectId: "1001",
    };

    const result = await agent.dispatchForIdentity(request);

    expect(result).toEqual({
      conversationId: expect.stringMatching(/^local:web:/),
      status: "created",
    });
    if (result.status !== "created") throw new Error("Expected a dispatch");
    // The work is not in Slack.
    expect(getCapturedSlackApiCalls("conversations.open")).toEqual([]);
    expect(queue.sentRecords()).toEqual([
      expect.objectContaining({ conversationId: result.conversationId }),
    ]);
    await expect(
      readStartedConversation(result.conversationId),
    ).resolves.toMatchObject({
      actor: { email: "requester@example.com" },
      destination: { platform: "local" },
      message: { authorId: userId, text: "Look at demo issue 7." },
      visibility: "public",
    });
    // The dashboard lists it for the person and shows it to everyone else.
    const access = await readConversationAccessFromSql(
      getDb(),
      [result.conversationId],
      { id: userId, email: "requester@example.com", identities: [] },
    );
    expect(access.get(result.conversationId)).toMatchObject({
      isParticipant: true,
      visibility: "public",
    });

    // A redelivered webhook reuses its idempotency key.
    await expect(agent.dispatchForIdentity(request)).resolves.toEqual({
      conversationId: result.conversationId,
      status: "already_exists",
    });
  });

  it("drops identities without exactly one current linked Slack member", async () => {
    await seedSlackUser({
      email: "requester@example.com",
      linked: { handle: "octocat", provider: "demo", subjectId: "1001" },
      slackUserId: "U123",
    });
    // Another provider's account id does not name a demo Identity.
    await seedSlackUser({
      email: "other@example.com",
      linked: { provider: "github", subjectId: "2001" },
      slackUserId: "U222",
    });
    await seedSlackUser({
      email: "former@example.com",
      linked: { provider: "demo", subjectId: "1003" },
      slackUserId: "U456",
    });
    // One person with two Slack accounts in the workspace is ambiguous.
    await seedSlackUser({ email: "twice@example.com", slackUserId: "U777" });
    await seedSlackUser({
      email: "twice@example.com",
      linked: { provider: "demo", subjectId: "1004" },
      slackUserId: "U778",
    });
    // Core links native Google sign-in identities, not plugin OAuth.
    await seedSlackUser({
      email: "signed-in@example.com",
      linked: { provider: "google", subjectId: "google-sub-1" },
      slackUserId: "U333",
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U456", deleted: true }),
    });

    await expect(
      googleAgent.dispatchForIdentity({
        idempotencyKey: "delivery-google",
        input: "Look at demo issue 7.",
        subjectId: "google-sub-1",
      }),
    ).resolves.toEqual({ status: "not_linked" });
    for (const subjectId of ["2001", "octocat", "1003", "1004"]) {
      await expect(
        agent.dispatchForIdentity({
          idempotencyKey: `delivery-${subjectId}`,
          input: "Look at demo issue 7.",
          subjectId,
        }),
      ).resolves.toEqual({ status: "not_linked" });
    }

    expect(
      getCapturedSlackApiCalls("users.info").map((call) => call.params.user),
    ).toEqual(["U456"]);
    expect(queue.sentRecords()).toEqual([]);
  });

  it("drops a linked member whose Slack email is not on the allowed domains", async () => {
    await startApp(["example.com"]);
    await seedSlackUser({
      email: "someone@contractor.dev",
      linked: { provider: "demo", subjectId: "1005" },
      slackUserId: "U555",
    });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U555", email: "someone@contractor.dev" }),
    });

    await expect(
      agent.dispatchForIdentity({
        idempotencyKey: "delivery-1005",
        input: "Look at demo issue 7.",
        subjectId: "1005",
      }),
    ).resolves.toEqual({ status: "not_linked" });
    expect(queue.sentRecords()).toEqual([]);
  });

  it("starts work from a heartbeat for a verified email of a current member", async () => {
    const mayaUserId = await seedSlackUser({
      email: "maya@example.com",
      slackUserId: "U900",
    });
    await seedSlackUser({ email: "stale@example.com", slackUserId: "U901" });
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U900", email: "Maya@Example.com" }),
    });
    // The person changed the email of their Slack profile.
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({ userId: "U901", email: "new@example.com" }),
    });
    const results: unknown[] = [];
    // The Google plugin shares a native provider name. That blocks only
    // `subjectId`, not a verified email.
    onGoogleHeartbeat = async (heartbeatAgent) => {
      for (const verifiedEmail of [
        "MAYA@example.com",
        "nobody@example.com",
        "stale@example.com",
      ]) {
        results.push(
          await heartbeatAgent.dispatchForIdentity({
            idempotencyKey: `email-${verifiedEmail}`,
            input: "Find us 30 minutes next week.",
            verifiedEmail,
          }),
        );
      }
    };

    const response = await app.request("/api/internal/heartbeat", {
      headers: { authorization: "Bearer heartbeat-secret" },
    });
    expect(response.status).toBe(202);
    await waitUntil.flush();

    expect(results).toEqual([
      { conversationId: expect.any(String), status: "created" },
      { status: "not_linked" },
      { status: "not_linked" },
    ]);
    const [created] = results as { conversationId: string }[];
    await expect(
      readStartedConversation(created!.conversationId),
    ).resolves.toMatchObject({
      actor: { email: "maya@example.com" },
      message: { authorId: mayaUserId, text: "Find us 30 minutes next week." },
      visibility: "public",
    });
  });
});
