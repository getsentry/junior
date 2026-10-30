import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  conversationPendingMessagesReportSchema,
  steerConversationPendingMessagesResponseSchema,
} from "@/api/schema";
import {
  appendAndEnqueueWebMessage,
  createAndEnqueueConversation,
} from "@/chat/conversations/web-input";
import { closeDb } from "@/chat/db";
import {
  closeConversationFixture,
  createConversationFixture,
} from "../../../fixtures/conversation";
import { testViewer } from "../../../fixtures/user";

function apiFor(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer(email));
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

describe("conversation steer pending messages API", () => {
  afterEach(async () => {
    await closeConversationFixture();
    await closeDb();
  });

  it("lets only the author's participant session steer a queued web message", async () => {
    const { actor, conversationStore, queue, state } =
      await createConversationFixture();
    const created = await createAndEnqueueConversation(
      { actor, idempotencyKey: "steer-api-root", message: "first" },
      { conversationStore, queue, state },
    );
    const queued = await appendAndEnqueueWebMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "steer-api-second",
        message: "second",
      },
      { conversationStore, queue, state },
    );
    const path = `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`;
    const steer = (email: string) =>
      apiFor(email).request(`${path}/steer`, {
        body: JSON.stringify({ inboundMessageIds: [queued.messageId] }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    expect((await steer("mallory@example.com")).status).toBe(403);

    const response = await steer(actor.email);
    expect(response.status).toBe(200);
    expect(
      steerConversationPendingMessagesResponseSchema.parse(
        await response.json(),
      ).steeredInboundMessageIds,
    ).toEqual([queued.messageId]);

    const report = conversationPendingMessagesReportSchema.parse(
      await (await apiFor(actor.email).request(path)).json(),
    );
    expect(
      report.messages.map((message) => [message.text, message.delivery]),
    ).toEqual([
      ["first", "defer"],
      ["second", "interrupt"],
    ]);
  });
});
