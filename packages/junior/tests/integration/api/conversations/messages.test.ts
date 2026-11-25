import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  conversationPendingMessagesReportSchema,
} from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import { getDb, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { juniorConversationParticipants, juniorIdentities } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../../fixtures/conversation";
import {
  SLACK_DESTINATION,
  createConversationWorkQueueTestAdapter,
} from "../../../fixtures/conversation-work";
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

describe("conversation messages API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("lets a signed-in person join a public conversation by posting, but not a private one", async () => {
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
