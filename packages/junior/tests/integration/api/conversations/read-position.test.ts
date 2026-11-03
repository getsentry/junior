import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  conversationEventPageSchema,
  conversationReadPositionSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationEvents } from "@/db/schema";

async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return { app, viewer };
}

async function recordConversation(conversationId: string) {
  await getConversationStore().recordActivity({
    destination: { platform: "local" as const, conversationId },
    conversationId,
    nowMs: 1_000,
    source: "internal",
    title: "Read position",
  });
}

async function seedConversation(conversationId: string, eventCount: number) {
  await recordConversation(conversationId);
  await getDb()
    .insert(juniorConversationEvents)
    .values(
      Array.from({ length: eventCount }, (_, seq) => ({
        conversationId,
        createdAt: new Date(1_000 + seq),
        historyVersion: 0,
        payload: {
          content: `Message ${seq}`,
          provenance: {
            authority: "instruction",
            actor: { name: "event", platform: "system" },
          },
          timestamp: 1_000 + seq,
        },
        schemaVersion: 1,
        seq,
        type: "user_message",
      })),
    );
}

function putReadPosition(
  app: Hono<JuniorApiEnv>,
  conversationId: string,
  lastReadSeq: number,
) {
  return app.request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/read-position`,
    {
      body: JSON.stringify({ lastReadSeq }),
      headers: { "content-type": "application/json" },
      method: "PUT",
    },
  );
}

describe("conversation read position API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("keeps one forward-only read position per viewer and shows it on detail", async () => {
    const conversationId = "local:test:read-position";
    await seedConversation(conversationId, 5);
    const { app, viewer } = await authenticatedApi("reader@example.com");
    const { viewer: otherViewer } = await authenticatedApi(
      "other-reader@example.com",
    );

    const first = await putReadPosition(app, conversationId, 2);
    expect(first.status).toBe(200);
    expect(conversationReadPositionSchema.parse(await first.json())).toEqual({
      lastReadSeq: 2,
    });

    // Another device that reports an older place does not move it back.
    const older = await putReadPosition(app, conversationId, 1);
    expect(conversationReadPositionSchema.parse(await older.json())).toEqual({
      lastReadSeq: 2,
    });

    // A place after the last event stops at the last event.
    const ahead = await putReadPosition(app, conversationId, 99);
    expect(conversationReadPositionSchema.parse(await ahead.json())).toEqual({
      lastReadSeq: 4,
    });

    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer }),
      ).readPosition,
    ).toEqual({ lastReadSeq: 4 });
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer: otherViewer }),
      ).readPosition,
    ).toBeUndefined();
  });

  it("pages both ways from a read position that is older than the latest page", async () => {
    const conversationId = "local:test:read-position-paging";
    await recordConversation(conversationId);
    await getConversationEventStore().append(
      conversationId,
      Array.from({ length: 30 }, (_, seq) => ({
        createdAtMs: 1_000 + seq,
        data: {
          type: "message" as const,
          messageId: `message-${seq}`,
          role: "assistant" as const,
          text: `Message ${seq}`,
        },
      })),
    );
    const { app, viewer } = await authenticatedApi("reader@example.com");
    await putReadPosition(app, conversationId, 5);

    const detail = conversationDetailReportSchema.parse(
      await readConversationDetail(conversationId, { limit: 10, viewer }),
    );
    expect(detail.events.map((event) => event.seq)).toEqual(
      Array.from({ length: 10 }, (_, index) => 20 + index),
    );
    expect(detail.unreadCursor).toBeDefined();

    const readPage = async (query: string) => {
      const response = await app.request(
        `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/events?${query}&limit=10`,
      );
      expect(response.status).toBe(200);
      return conversationEventPageSchema.parse(await response.json());
    };
    const unread = await readPage(
      `after=${encodeURIComponent(detail.unreadCursor!)}`,
    );
    const newer: number[] = [];
    let page = unread;
    while (true) {
      newer.push(...page.events.map((event) => event.seq));
      if (!page.nextCursor) break;
      page = await readPage(`after=${encodeURIComponent(page.nextCursor)}`);
    }
    expect(newer).toEqual(Array.from({ length: 24 }, (_, index) => 6 + index));

    const earlier = await readPage(
      `before=${encodeURIComponent(unread.previousCursor!)}`,
    );
    expect(earlier.events.map((event) => event.seq)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(earlier.previousCursor).toBeUndefined();

    // Once the reader is inside the latest page, it opens there.
    await putReadPosition(app, conversationId, 25);
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { limit: 10, viewer }),
      ).unreadCursor,
    ).toBeUndefined();
  });

  it("requires a viewer and an existing conversation", async () => {
    const conversationId = "local:test:read-position-missing";
    await seedConversation(conversationId, 1);

    const unauthenticated = await createJuniorApi().request(
      `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/read-position`,
      {
        body: JSON.stringify({ lastReadSeq: 0 }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      },
    );
    expect(unauthenticated.status).toBe(401);

    const { app } = await authenticatedApi("reader@example.com");
    const missing = await putReadPosition(app, "local:test:no-such", 0);
    expect(missing.status).toBe(404);
  });
});
