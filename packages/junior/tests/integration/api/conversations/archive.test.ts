import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationFeed } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  apiErrorSchema,
  archiveConversationResponseSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { juniorConversationParticipants, juniorUsers } from "@/db/schema";
import { eq } from "drizzle-orm";

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

  it("archives a conversation only for the viewer and exposes archivedAt on detail", async () => {
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
    ).toEqual({ archivedAt: expect.any(String) });
    await expect(readConversationFeed({ viewer })).resolves.toMatchObject({
      conversations: [],
    });
    await expect(
      readConversationFeed({ viewer: otherViewer }),
    ).resolves.toMatchObject({
      conversations: [expect.objectContaining({ conversationId })],
    });

    const archivedDetail = conversationDetailReportSchema.parse(
      await readConversationDetail(conversationId, { viewer }),
    );
    expect(archivedDetail.archivedAt).toEqual(expect.any(String));
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer: otherViewer }),
      ).archivedAt,
    ).toBeNull();

    await getConversationStore().recordActivity({
      conversationId,
      nowMs: Date.parse(lastSeenAt) + 1_000,
      source: "internal",
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
    expect(
      archiveConversationResponseSchema.parse(await restore.json()),
    ).toEqual({ archivedAt: null });
    await expect(readConversationFeed({ viewer })).resolves.toMatchObject({
      conversations: [expect.objectContaining({ conversationId })],
    });
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer }),
      ).archivedAt,
    ).toBeNull();
  });

  it("archives for a root actor without an existing participant row", async () => {
    const conversationId = "internal:archive-root-actor";
    const lastSeenAt = "1970-01-01T00:00:02.000Z";
    const email = "root-actor@example.com";
    await getConversationStore().recordActivity({
      actor: {
        email,
        platform: "slack",
        slackUserId: "UROOT",
        teamId: "T1",
      },
      conversationId,
      nowMs: Date.parse(lastSeenAt),
      source: "slack",
      title: "Root actor archive",
    });
    const linkedUser = await getDb()
      .select({ id: juniorUsers.id })
      .from(juniorUsers)
      .where(eq(juniorUsers.primaryEmailNormalized, email))
      .limit(1);
    const viewerId = linkedUser[0]?.id;
    expect(viewerId).toBeDefined();
    await getDb()
      .delete(juniorConversationParticipants)
      .where(eq(juniorConversationParticipants.userId, viewerId!));

    const viewer = {
      ...(await resolveViewerUser(email))!,
      id: viewerId!,
    };
    const { app } = await authenticatedApi(email);
    const archive = await app.request(
      `http://localhost/api/conversations/${conversationId}/archive`,
      {
        body: JSON.stringify({ archived: true, lastSeenAt }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(archive.status).toBe(200);
    await expect(readConversationFeed({ viewer })).resolves.toMatchObject({
      conversations: [],
    });
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer }),
      ).archivedAt,
    ).toEqual(expect.any(String));
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
