import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  cancelConversationPendingMessagesResponseSchema,
  conversationPendingMessagesReportSchema,
} from "@/api/schema";
import {
  appendAndEnqueueApiConversationMessage,
  createAndEnqueueApiConversation,
} from "@/chat/api-turns/work";
import { closeDb } from "@/chat/db";
import {
  appendInboundMessage,
  getConversation,
  releaseConversationWork,
  startConversationWork,
} from "@/chat/task-execution/store";
import {
  closeApiTurnWorkFixture,
  createApiTurnWorkFixture,
} from "../../../fixtures/api-turn";
import { testViewer } from "../../../fixtures/user";

describe("conversation cancel pending messages API", () => {
  afterEach(async () => {
    await closeApiTurnWorkFixture();
    await closeDb();
  });

  it("cancels accepted web mailbox rows for participants", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const created = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "cancel-root",
        message: "first",
      },
      { conversationStore, queue, state },
    );
    const continued = await appendAndEnqueueApiConversationMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "cancel-second",
        message: "second",
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
    await releaseConversationWork({
      conversationId: created.conversationId,
      leaseToken: lease.leaseToken,
      nowMs: 3_000,
      state,
    });
    await expect(
      getConversation({ conversationId: created.conversationId, state }),
    ).resolves.toMatchObject({
      execution: { runId: expect.any(String), status: "pending" },
    });

    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (context, next) => {
      context.set("viewer", testViewer(actor.email));
      await next();
    });
    app.route("/", createJuniorApi());

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
      {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      },
    );
    expect(response.status).toBe(200);
    const cancelled = cancelConversationPendingMessagesResponseSchema.parse(
      await response.json(),
    );
    expect(cancelled.conversationId).toBe(created.conversationId);
    expect(cancelled.cancelledCount).toBe(2);
    expect(cancelled.cancelledInboundMessageIds.sort()).toEqual(
      [created.messageId, continued.messageId].sort(),
    );

    const pending = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
    );
    expect(pending.status).toBe(200);
    const report = conversationPendingMessagesReportSchema.parse(
      await pending.json(),
    );
    expect(report.messages).toEqual([]);

    const work = await getConversation({
      conversationId: created.conversationId,
      state,
    });
    expect(work?.execution.pendingMessages).toEqual([]);
    expect(work?.execution.status).toBe("idle");
    expect(work?.execution.retryCount).toBe(0);
    expect(work?.execution.runId).toBeUndefined();
    expect(work?.execution.inboundMessageIds).toEqual(
      expect.arrayContaining([created.messageId, continued.messageId]),
    );
  });

  it("keeps messages received after the requested snapshot", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const created = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "cancel-snapshot-root",
        message: "first",
      },
      { conversationStore, nowMs: 1_000, queue, state },
    );
    const later = await appendAndEnqueueApiConversationMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "cancel-snapshot-later",
        message: "later",
      },
      { conversationStore, nowMs: 3_000, queue, state },
    );

    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (context, next) => {
      context.set("viewer", testViewer(actor.email));
      await next();
    });
    app.route("/", createJuniorApi());

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
      {
        body: JSON.stringify({
          inboundMessageIds: [created.messageId, later.messageId],
          receivedBefore: new Date(2_000).toISOString(),
        }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      },
    );
    expect(response.status).toBe(200);
    const cancelled = cancelConversationPendingMessagesResponseSchema.parse(
      await response.json(),
    );
    expect(cancelled.cancelledInboundMessageIds).toEqual([created.messageId]);

    const work = await getConversation({
      conversationId: created.conversationId,
      state,
    });
    expect(
      work?.execution.pendingMessages.map((message) => message.inboundMessageId),
    ).toEqual([later.messageId]);
    expect(work?.execution.status).toBe("pending");
  });

  it("rejects cancel from non-participants", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const created = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "cancel-forbidden",
        message: "secret",
        visibility: "private",
      },
      { conversationStore, queue, state },
    );

    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (context, next) => {
      context.set("viewer", testViewer("stranger@example.com"));
      await next();
    });
    app.route("/", createJuniorApi());

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
      {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      },
    );
    expect(response.status).toBe(403);

    const work = await getConversation({
      conversationId: created.conversationId,
      state,
    });
    expect(work?.execution.pendingMessages).toHaveLength(1);
  });

  it("keeps internal mailbox work when cancelling human-facing rows", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const created = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "cancel-keep-internal-root",
        message: "human",
      },
      { conversationStore, queue, state },
    );

    const existing = await getConversation({
      conversationId: created.conversationId,
      state,
    });
    await appendInboundMessage({
      message: {
        conversationId: created.conversationId,
        createdAtMs: Date.now(),
        delivery: "defer",
        ...(existing?.destination ? { destination: existing.destination } : {}),
        inboundMessageId: "internal:keep-me",
        input: {
          authorId: "system",
          text: "internal wake",
        },
        receivedAtMs: Date.now(),
        publishExternally: false,
        source: "internal",
      },
      state,
    });

    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (context, next) => {
      context.set("viewer", testViewer(actor.email));
      await next();
    });
    app.route("/", createJuniorApi());

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
      {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      },
    );
    expect(response.status).toBe(200);
    const cancelled = cancelConversationPendingMessagesResponseSchema.parse(
      await response.json(),
    );
    expect(cancelled.cancelledInboundMessageIds).toEqual([created.messageId]);

    const work = await getConversation({
      conversationId: created.conversationId,
      state,
    });
    expect(
      work?.execution.pendingMessages.map((m) => m.inboundMessageId),
    ).toEqual(["internal:keep-me"]);
    expect(work?.execution.status).toBe("pending");
  });

  it("returns 404 for unknown conversations", async () => {
    await createApiTurnWorkFixture();
    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (context, next) => {
      context.set("viewer", testViewer("owner@example.com"));
      await next();
    });
    app.route("/", createJuniorApi());

    const response = await app.request(
      "http://localhost/api/conversations/missing/pending-messages",
      {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      },
    );
    expect(response.status).toBe(404);
  });
});
