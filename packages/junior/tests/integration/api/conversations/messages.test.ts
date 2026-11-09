import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createConversationRoutes } from "@/api/conversations/routes";
import type { JuniorApiEnv } from "@/api/route";
import {
  acceptedConversationMessageSchema,
  conversationPendingMessagesReportSchema,
} from "@/api/schema";
import { createMemoryAttachmentStorage } from "@/chat/attachments/memory";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";
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
    expect(pending.messages).toContainEqual(
      expect.objectContaining({
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
});
