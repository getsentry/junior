import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { stopConversationTurnForViewer } from "@/api/conversations/stop";
import {
  acceptedConversationMessageSchema,
  conversationPendingMessagesReportSchema,
  stopConversationTurnResponseSchema,
} from "@/api/schema";
import { createAndEnqueueConversation } from "@/chat/conversations/web-input";
import { closeDb } from "@/chat/db";
import {
  getConversation,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../../fixtures/conversation";
import { testViewer } from "../../../fixtures/user";

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("conversation turn controls API", () => {
  afterEach(async () => {
    await closeConversationFixture();
    await closeDb();
  });

  it("accepts an explicit dashboard steering message", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const created = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "steer-root",
        message: "first",
      },
      { conversationStore, queue, state },
    );
    const app = authenticatedApi(actor.email);

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/messages`,
      {
        body: JSON.stringify({
          delivery: "interrupt",
          idempotencyKey: "steer-next",
          message: "change course",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    expect(response.status).toBe(200);
    acceptedConversationMessageSchema.parse(await response.json());

    const pendingResponse = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
    );
    const pending = conversationPendingMessagesReportSchema.parse(
      await pendingResponse.json(),
    );
    expect(pending.messages.at(-1)).toMatchObject({
      delivery: "interrupt",
      source: "web",
      text: "change course",
    });
  });

  it("requests that an active dashboard turn stop", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const created = await createAndEnqueueConversation(
      {
        actor,
        idempotencyKey: "stop-root",
        message: "first",
      },
      { conversationStore, queue, state },
    );
    const lease = await startConversationWork({
      conversationId: created.conversationId,
      nowMs: 2_000,
      state,
    });
    expect(lease.status).toBe("acquired");
    if (lease.status !== "acquired") throw new Error("Expected work lease");

    expect(
      stopConversationTurnResponseSchema.parse(
        await stopConversationTurnForViewer(
          testViewer(actor.email),
          created.conversationId,
          { queue },
        ),
      ),
    ).toEqual({
      conversationId: created.conversationId,
      status: "requested",
    });
    await expect(
      getConversation({ conversationId: created.conversationId, state }),
    ).resolves.toMatchObject({
      execution: { stop: { runId: expect.any(String) } },
    });
  });
});
