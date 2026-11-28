import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  conversationPendingMessagesReportSchema,
} from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { getChatConfig } from "@/chat/config";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import {
  startLocalVercelQueueServer,
  type LocalVercelQueueServer,
} from "@/chat/queue/local-server";
import {
  juniorConversationParticipants,
  juniorIdentities,
  juniorTurnInbox,
} from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../../fixtures/conversation";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../../fixtures/conversation-work";
import { patchConfig } from "../../../fixtures/config";
import { signedInViewer } from "../../../fixtures/user";

function apiFor(email: string): Hono<JuniorApiEnv> {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", await signedInViewer(email));
    await next();
  });
  app.route(
    "/api/conversations",
    createConversationRoutes({
      attachmentStorage: createMemoryAttachmentStorage(),
      queue: createConversationWorkQueueTestAdapter(),
      waitUntil: () => undefined,
    }),
  );
  return app;
}

/** Join a public root through its Subscribe route, as the dashboard does. */
async function join(email: string, conversationId: string) {
  return await apiFor(email).request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/subscription`,
    {
      body: JSON.stringify({ subscribed: true }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
}

describe("conversation messages API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("takes Messages only from Participants: a reader of a public conversation Joins first", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const post = async (conversationId: string, idempotencyKey: string) =>
      await apiFor("newcomer@example.com").request(
        `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/messages`,
        {
          body: JSON.stringify({ idempotencyKey, message: "Can I help?" }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

    const shared = await createAndEnqueueConversation(
      { actor, idempotencyKey: "join-public-root", message: "first" },
      { conversationStore, queue, state },
    );
    expect((await post(shared.conversationId, "before-join")).status).toBe(403);
    expect(
      (await join("newcomer@example.com", shared.conversationId)).status,
    ).toBe(200);
    const joined = await post(shared.conversationId, "join-public");
    expect(joined.status).toBe(200);
    const accepted = acceptedConversationMessageSchema.parse(
      await joined.json(),
    );
    const pending = conversationPendingMessagesReportSchema.parse(
      await (
        await apiFor("newcomer@example.com").request(
          `http://localhost/api/conversations/${encodeURIComponent(shared.conversationId)}/pending-messages`,
        )
      ).json(),
    );
    // A dashboard message steers the running Turn, like a Slack mention.
    expect(pending.messages).toContainEqual(
      expect.objectContaining({
        delivery: "interrupt",
        messageId: accepted.messageId,
        text: "Can I help?",
      }),
    );

    const secret = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "join-private-root",
        message: "first",
        visibility: "private",
      },
      { conversationStore, queue, state },
    );
    expect((await post(secret.conversationId, "join-private")).status).toBe(
      403,
    );
  });

  it("does not link a Slack root Actor to a person who posts from the dashboard", async () => {
    const { conversationStore } = await createConversationFixture();
    // Slack returned no email for the person who started these threads, so
    // their Slack Identity has no User.
    const starter = {
      platform: "slack" as const,
      slackUserId: "U0STARTER",
      teamId: SLACK_DESTINATION.teamId,
    };
    const posted = "slack:C123:1794290907.000001";
    const other = "slack:C123:1794290907.000002";
    for (const conversationId of [posted, other]) {
      await conversationStore.recordActivity({
        actor: starter,
        conversationId,
        destination: SLACK_DESTINATION,
        source: "slack",
        visibility: "public",
      });
    }

    expect((await join("newcomer@example.com", posted)).status).toBe(200);
    const response = await apiFor("newcomer@example.com").request(
      `http://localhost/api/conversations/${encodeURIComponent(posted)}/messages`,
      {
        body: JSON.stringify({ idempotencyKey: "join-slack", message: "Hi" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(response.status).toBe(200);

    const [starterIdentity] = await getDb()
      .select({
        email: juniorIdentities.email,
        userId: juniorIdentities.userId,
      })
      .from(juniorIdentities)
      .where(
        and(
          eq(juniorIdentities.provider, "slack"),
          eq(juniorIdentities.providerSubjectId, starter.slackUserId),
        ),
      );
    expect(starterIdentity).toEqual({ email: null, userId: null });
    const newcomer = await signedInViewer("newcomer@example.com");
    const newcomerRoots = await getDb()
      .select({
        rootConversationId: juniorConversationParticipants.rootConversationId,
      })
      .from(juniorConversationParticipants)
      .where(eq(juniorConversationParticipants.userId, newcomer.id));
    expect(newcomerRoots).not.toContainEqual({ rootConversationId: other });
  });

  it("shows a person that a dashboard conversation mentions by name", async () => {
    const { actor } = await createConversationFixture();
    await resolveActorIdentityId(getSqlExecutor(), {
      email: "cleo@example.com",
      fullName: "Cleo Person",
      platform: "slack",
      teamId: SLACK_DESTINATION.teamId,
      userId: "UCLEO1234",
    });
    const api = apiFor(actor.email);
    const created = acceptedConversationMessageSchema.parse(
      await (
        await api.request("http://localhost/api/conversations", {
          body: JSON.stringify({
            idempotencyKey: "mention-name",
            message: "<@UCLEO1234> can you check this?",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      ).json(),
    );

    // A dashboard conversation is in no Slack workspace, so the mention
    // resolves from Junior's people.
    const pending = conversationPendingMessagesReportSchema.parse(
      await (
        await api.request(
          `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
        )
      ).json(),
    );
    expect(
      pending.messages.flatMap((message) => message.mentions ?? []),
    ).toEqual([
      expect.objectContaining({
        email: "cleo@example.com",
        fullName: "Cleo Person",
        slackUserId: "UCLEO1234",
      }),
    ]);
  });
});

describe("conversation messages on the core Turn engine", () => {
  // Core publishes each Turn message to Vercel Queues. The server keeps them
  // with no consumer, so a test reads only the stored input.
  let queueServer: LocalVercelQueueServer;

  beforeAll(async () => {
    queueServer = await startLocalVercelQueueServer({ consumers: [] });
  });

  afterAll(async () => {
    await queueServer.close();
  });

  afterEach(async () => {
    await closeConversationFixture();
  });

  it("gives a core input the privacy of its dashboard conversation", async () => {
    patchConfig({
      turnEngine: "core",
      queue: { ...getChatConfig().queue, apiUrl: queueServer.url.href },
    });
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const sourceOf = async (visibility: "private" | "public") => {
      const { conversationId } = await createAndEnqueueConversation(
        {
          actor,
          idempotencyKey: `core-${visibility}`,
          message: "hello",
          visibility,
        },
        { conversationStore, queue, state },
      );
      const [input] = await getDb()
        .select({ source: juniorTurnInbox.source })
        .from(juniorTurnInbox)
        .where(eq(juniorTurnInbox.conversationId, conversationId));
      return input?.source;
    };

    await expect(sourceOf("private")).resolves.toMatchObject({
      kind: "web",
      visibility: "private",
    });
    await expect(sourceOf("public")).resolves.toMatchObject({
      kind: "web",
      visibility: "public",
    });
  });
});
