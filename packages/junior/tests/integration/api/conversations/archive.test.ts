import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  apiErrorSchema,
  archiveConversationResponseSchema,
} from "@/api/schema";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants } from "@/db/schema";

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

async function addParticipant(args: {
  conversationId: string;
  email: string;
  lastMessageAt: Date;
}) {
  const viewer = await resolveViewerUser(args.email);
  if (!viewer) throw new Error(`missing viewer for ${args.email}`);
  await getDb().insert(juniorConversationParticipants).values({
    lastMessageAt: args.lastMessageAt,
    rootConversationId: args.conversationId,
    userId: viewer.id,
  });
  return viewer;
}

describe("conversation archive API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("archives a conversation only for the viewer", async () => {
    const conversationId = "internal:archive-route";
    const lastSeenAt = "1970-01-01T00:00:01.000Z";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: Date.parse(lastSeenAt),
      source: "internal",
      title: "Archive route",
    });
    const viewer = await addParticipant({
      conversationId,
      email: "viewer@example.com",
      lastMessageAt: new Date(lastSeenAt),
    });
    const otherViewer = await addParticipant({
      conversationId,
      email: "other@example.com",
      lastMessageAt: new Date(lastSeenAt),
    });
    const { app } = await authenticatedApi(viewer.email);

    const archive = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({ archived: true, lastSeenAt }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archive.status).toBe(200);
    expect(
      archiveConversationResponseSchema.parse(await archive.json()),
    ).toEqual({ archived: true });
    await expect(readConversationFeed({ viewer })).resolves.toMatchObject({
      conversations: [],
    });
    await expect(
      readConversationFeed({ viewer: otherViewer }),
    ).resolves.toMatchObject({
      conversations: [expect.objectContaining({ conversationId })],
    });

    const restore = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({ archived: false, lastSeenAt }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(restore.status).toBe(200);
    await expect(readConversationFeed({ viewer })).resolves.toMatchObject({
      conversations: [expect.objectContaining({ conversationId })],
    });
  });

  it("requires a viewer and rejects stale activity", async () => {
    const conversationId = "internal:archive-conflict";
    await getConversationStore().recordActivity({
      conversationId,
      nowMs: 1_000,
      source: "internal",
    });
    await addParticipant({
      conversationId,
      email: "viewer@example.com",
      lastMessageAt: new Date(1_000),
    });

    const unauthenticated = await createJuniorApi().request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: "1970-01-01T00:00:01.000Z",
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(unauthenticated.status).toBe(401);

    const { app } = await authenticatedApi("viewer@example.com");
    const stale = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({
          archived: true,
          lastSeenAt: "1970-01-01T00:00:00.999Z",
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(stale.status).toBe(409);
    expect(apiErrorSchema.parse(await stale.json())).toEqual({
      error: "Conversation received new activity.",
    });
  });
});
