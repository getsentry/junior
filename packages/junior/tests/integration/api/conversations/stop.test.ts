import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { stopConversationTurnResponseSchema } from "@/api/schema";
import {
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
  webActorFromEmail,
} from "@/chat/conversations/web-input";
import {
  ackMessages,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { testViewer } from "../../../fixtures/user";

function stopRequest(
  fixture: ConversationFixture,
  conversationId: string,
  email: string,
) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/stop`,
    { method: "POST" },
  );
}

describe("conversation stop API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("stops the active Turn and returns only the viewer's queued text", async () => {
    const fixture = await createConversationFixture();
    const { actor, conversationStore, queue, state } = fixture;
    const created = await createAndEnqueueConversation(
      { actor, idempotencyKey: "stop-root", message: "Start a long Turn." },
      { conversationStore, queue, state },
    );
    // Hold the lease like a running Turn that already took its input.
    const lease = await startConversationWork({
      conversationId: created.conversationId,
      conversationStore,
      state,
    });
    if (lease.status !== "acquired") throw new Error("Expected work lease");
    await ackMessages({
      conversationId: created.conversationId,
      conversationStore,
      inboundMessageIds: [created.messageId],
      leaseToken: lease.leaseToken,
      state,
    });
    const queued = await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "stop-queued",
        message: "Queued while running.",
      },
      { conversationStore, queue, state },
    );
    const otherActor = webActorFromEmail("bob@example.com");
    const otherQueued = await appendAndEnqueueWebMessage(
      {
        actor: otherActor,
        conversationId: created.conversationId,
        idempotencyKey: "stop-queued-other",
        message: "Bob's queued note.",
      },
      { conversationStore, queue, state },
    );

    const stranger = await stopRequest(
      fixture,
      created.conversationId,
      "stranger@example.com",
    );
    expect(stranger.status).toBe(403);

    const response = await stopRequest(
      fixture,
      created.conversationId,
      actor.email,
    );
    expect(response.status).toBe(200);
    expect(
      stopConversationTurnResponseSchema.parse(await response.json()),
    ).toEqual({
      conversationId: created.conversationId,
      status: "requested",
      stoppedInboundMessageIds: [queued.messageId, otherQueued.messageId],
      stoppedMessages: [
        { inboundMessageId: queued.messageId, text: "Queued while running." },
      ],
    });
  });
});
