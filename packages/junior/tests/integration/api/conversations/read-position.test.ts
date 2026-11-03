import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import type { JuniorApiEnv } from "@/api/route";
import {
  conversationDetailReportSchema,
  conversationReadPositionSchema,
} from "@/api/schema";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
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

async function seedConversation(conversationId: string, eventCount: number) {
  await getConversationStore().recordActivity({
    destination: { platform: "local" as const, conversationId },
    conversationId,
    nowMs: 1_000,
    source: "internal",
    title: "Read position",
  });
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
