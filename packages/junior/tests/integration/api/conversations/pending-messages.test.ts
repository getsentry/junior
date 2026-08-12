import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  conversationPendingMessagesReportSchema,
  type ConversationPendingMessagesReport,
} from "@/api/schema";
import {
  appendAndEnqueueApiConversationMessage,
  createAndEnqueueApiConversation,
} from "@/chat/api-turns/work";
import { closeDb, getConversationStore } from "@/chat/db";
import { appendInboundMessage } from "@/chat/task-execution/store";
import {
  closeApiTurnWorkFixture,
  createApiTurnWorkFixture,
} from "../../../fixtures/api-turn";
import { usersInfoOk } from "../../../fixtures/slack/factories/api";
import { testViewer } from "../../../fixtures/user";
import { queueSlackApiResponse } from "../../../msw/handlers/slack-api";

describe("conversation pending messages API", () => {
  afterEach(async () => {
    await closeApiTurnWorkFixture();
    await closeDb();
  });

  it("returns accepted web mailbox rows before history commit", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const accepted = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "pending-web-1",
        message: "dashboard follow-up",
      },
      { conversationStore, queue, state },
    );

    const app = createJuniorApi();
    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(accepted.conversationId)}/pending-messages`,
    );
    expect(response.status).toBe(200);
    const report = conversationPendingMessagesReportSchema.parse(
      await response.json(),
    ) satisfies ConversationPendingMessagesReport;

    expect(report.conversationId).toBe(accepted.conversationId);
    expect(report.messages).toEqual([
      {
        actorIdentity: {
          email: actor.email,
          ...(actor.fullName ? { fullName: actor.fullName } : {}),
        },
        createdAt: expect.any(String),
        delivery: "defer",
        inboundMessageId: accepted.messageId,
        messageId: accepted.messageId,
        receivedAt: expect.any(String),
        role: "user",
        source: "web",
        text: "dashboard follow-up",
      },
    ]);
  });

  it("lets a participant cancel one pending mailbox row", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const accepted = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "pending-cancel-1",
        message: "cancel this follow-up",
      },
      { conversationStore, queue, state },
    );

    const app = new Hono<{ Variables: JuniorApiVariables }>();
    app.use("*", async (context, next) => {
      context.set("viewer", testViewer(actor.email));
      await next();
    });
    app.route("/", createJuniorApi());

    const cancelResponse = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(accepted.conversationId)}/pending-messages/${encodeURIComponent(accepted.messageId)}`,
      { method: "DELETE" },
    );
    expect(cancelResponse.status).toBe(204);

    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(accepted.conversationId)}/pending-messages`,
    );
    const report = conversationPendingMessagesReportSchema.parse(
      await response.json(),
    );
    expect(report.messages).toEqual([]);
  });

  it("returns accepted slack interrupt mailbox rows before history commit", async () => {
    const { state } = await createApiTurnWorkFixture();
    queueSlackApiResponse("users.info", {
      body: usersInfoOk({
        userId: "U123",
        userName: "slack.person",
        realName: "Slack Person",
        email: "slack.person@example.com",
      }),
    });
    const conversationId = "slack:C123:1712345.0001";
    await getConversationStore().recordActivity({
      actor: {
        email: "owner@example.com",
        platform: "slack",
        slackUserId: "UOWNER",
        teamId: "T123",
      },
      conversationId,
      destination: {
        channelId: "C123",
        platform: "slack",
        teamId: "T123",
      },
      nowMs: 1_000,
      source: "slack",
      title: "Slack pending",
      visibility: "public",
    });

    await appendInboundMessage({
      message: {
        conversationId,
        createdAtMs: 3_000,
        delivery: "interrupt",
        destination: {
          channelId: "C123",
          platform: "slack",
          teamId: "T123",
        },
        inboundMessageId: "slack:T123:slack:C123:1712345.0001:1712345.0099",
        input: {
          authorId: "U123",
          metadata: {
            message: {
              author: {
                fullName: "Slack Person",
                isBot: false,
                isMe: false,
                userId: "U123",
                userName: "slack.person",
              },
              formatted: { type: "text", value: "slack interrupt" },
              id: "1712345.0099",
              metadata: {
                dateSent: new Date(3_000).toISOString(),
                edited: false,
              },
              raw: {},
              text: "slack interrupt",
              threadId: "1712345.0001",
            },
            platform: "slack",
            route: "mention",
            thread: {
              _type: "chat:Thread",
              adapterName: "slack",
              channelId: "C123",
              id: "1712345.0001",
              isDM: false,
            },
          },
          text: "slack interrupt",
        },
        receivedAtMs: 3_100,
        publishExternally: true,
        source: "slack",
      },
      nowMs: 3_100,
      state,
    });

    const app = createJuniorApi();
    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/pending-messages`,
    );
    expect(response.status).toBe(200);
    const report = conversationPendingMessagesReportSchema.parse(
      await response.json(),
    );

    expect(report.messages).toEqual([
      {
        actorIdentity: {
          email: "slack.person@example.com",
          fullName: "Slack Person",
          slackUserId: "U123",
          slackUserName: "slack.person",
        },
        createdAt: new Date(3_000).toISOString(),
        delivery: "interrupt",
        inboundMessageId: "slack:T123:slack:C123:1712345.0001:1712345.0099",
        messageId: "1712345.0099",
        receivedAt: new Date(3_100).toISOString(),
        role: "user",
        source: "slack",
        text: "slack interrupt",
      },
    ]);
  });

  it("redacts mailbox content for non-participants on private conversations", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const accepted = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "pending-private-1",
        message: "secret follow-up",
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
      `http://localhost/api/conversations/${encodeURIComponent(accepted.conversationId)}/pending-messages`,
    );
    expect(response.status).toBe(200);
    const report = conversationPendingMessagesReportSchema.parse(
      await response.json(),
    );
    expect(report.messages).toEqual([
      {
        createdAt: expect.any(String),
        delivery: "defer",
        inboundMessageId: accepted.messageId,
        messageId: accepted.messageId,
        receivedAt: expect.any(String),
        redacted: true,
        role: "user",
        source: "web",
      },
    ]);
  });

  it("returns 404 for unknown conversations", async () => {
    await createApiTurnWorkFixture();
    const app = createJuniorApi();
    const response = await app.request(
      "http://localhost/api/conversations/missing/pending-messages",
    );
    expect(response.status).toBe(404);
  });

  it("keeps append-only web continues visible in the mailbox snapshot", async () => {
    const { actor, conversationStore, queue, state } =
      await createApiTurnWorkFixture();
    const created = await createAndEnqueueApiConversation(
      {
        actor,
        idempotencyKey: "pending-continue-root",
        message: "first",
      },
      { conversationStore, queue, state },
    );
    const continued = await appendAndEnqueueApiConversationMessage(
      {
        actor,
        conversationId: created.conversationId,
        idempotencyKey: "pending-continue-2",
        message: "second",
      },
      { conversationStore, queue, state },
    );

    const app = createJuniorApi();
    const response = await app.request(
      `http://localhost/api/conversations/${encodeURIComponent(created.conversationId)}/pending-messages`,
    );
    const report = conversationPendingMessagesReportSchema.parse(
      await response.json(),
    );
    expect(report.messages.map((message) => message.messageId)).toEqual([
      created.messageId,
      continued.messageId,
    ]);
    expect(report.messages.map((message) => message.text)).toEqual([
      "first",
      "second",
    ]);
  });
});
