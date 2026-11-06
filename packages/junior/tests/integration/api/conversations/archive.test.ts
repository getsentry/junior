import { CONVERSATION_DETAIL_VERSION_HEADER } from "@/api/schema";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { updateUserAutoArchiveSettings } from "@/api/conversations/auto-archive";
import { createApp } from "@/app";
import { readConversationDetail } from "@/api/conversations/detail";
import {
  readConversationFeed,
  readConversationFeedFromSql,
} from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  apiErrorSchema,
  archiveConversationResponseSchema,
  archiveDoneConversationsResponseSchema,
  conversationAutoArchiveSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { insertReviewItem } from "@/chat/review-items/store";
import { juniorConversationParticipants, juniorUsers } from "@/db/schema";
import { JUNIOR_AUTO_ARCHIVE_ROUTE } from "@/deployment";
import { defineJuniorPlugins } from "@/plugins";
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
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    await closeDb();
  });

  it("archives a conversation only for the viewer and exposes archivedAt on detail", async () => {
    const conversationId = "local:test:archive-route";
    const lastSeenAt = "1970-01-01T00:00:01.000Z";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
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
      destination: { platform: "local" as const, conversationId },
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
    const conversationId = "local:test:archive-root-actor";
    const lastSeenAt = "1970-01-01T00:00:02.000Z";
    const email = "root-actor@example.com";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
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
    const conversationId = "local:test:archive-conflict";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
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

  it("auto-archives finished work after each viewer's grace period and respects per-conversation choices", async () => {
    const nowMs = Date.now();
    const hour = 60 * 60 * 1000;
    const doneId = "local:test:auto-archive-done";
    const unfinishedId = "local:test:auto-archive-unfinished";
    const optedOutId = "local:test:auto-archive-opted-out";
    // Old conversations are swept too; there is no lookback window.
    const oldId = "local:test:auto-archive-old";
    // The root is quiet, but its child had activity inside the grace period.
    const busyChildId = "local:test:auto-archive-busy-child";
    const pinnedId = "local:test:auto-archive-pinned";
    // No plugin reported work, so only the quiet checks decide it.
    const noWorkId = "local:test:auto-archive-no-work";
    // A child agent opened the pull request, so the work is on the child.
    const childDoneId = "local:test:auto-archive-child-done";
    const childOpenId = "local:test:auto-archive-child-open";
    for (const conversationId of [
      doneId,
      unfinishedId,
      optedOutId,
      oldId,
      busyChildId,
      pinnedId,
      noWorkId,
      childDoneId,
      childOpenId,
    ]) {
      await getConversationStore().recordActivity({
        destination: { platform: "local" as const, conversationId },
        conversationId,
        nowMs: nowMs - (conversationId === oldId ? 30 * 24 : 48) * hour,
        source: "internal",
      });
    }
    await getConversationStore().createChild({
      kind: "task",
      childConversationId: `${busyChildId}:child`,
      nowMs: nowMs - 2 * hour,
      parentConversationId: busyChildId,
    });
    for (const parentConversationId of [childDoneId, childOpenId]) {
      await getConversationStore().createChild({
        childConversationId: `${parentConversationId}:child`,
        nowMs: nowMs - 48 * hour,
        parentConversationId,
      });
    }
    const viewer = await addParticipant({
      conversationId: doneId,
      email: "auto@example.com",
      lastMessageAt: new Date(nowMs - 48 * hour),
    });
    for (const conversationId of [
      unfinishedId,
      optedOutId,
      oldId,
      busyChildId,
      pinnedId,
      noWorkId,
      childDoneId,
      childOpenId,
    ]) {
      await getDb()
        .insert(juniorConversationParticipants)
        .values({
          lastMessageAt: new Date(nowMs - 48 * hour),
          pinnedAt: conversationId === pinnedId ? new Date(nowMs) : null,
          rootConversationId: conversationId,
          userId: viewer.id,
        });
    }
    const otherViewer = await addParticipant({
      conversationId: doneId,
      email: "manual@example.com",
      lastMessageAt: new Date(nowMs - 48 * hour),
    });
    await updateUserAutoArchiveSettings(viewer.id, {
      autoArchiveDefault: true,
    });
    // Work finished 30 hours ago, inside this viewer's 36-hour grace period.
    await updateUserAutoArchiveSettings(otherViewer.id, {
      autoArchiveDefault: true,
      autoArchiveGraceHours: 36,
    });
    const finishedAt = new Date(nowMs - 30 * hour).toISOString();
    process.env.JUNIOR_SCHEDULER_SECRET = "auto-archive-secret";
    const juniorApp = await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "work",
            displayName: "Work",
            description: "Auto-archive work test plugin",
          },
          hooks: {
            unfinishedWork: () => ({
              assignedConversationIds: [
                doneId,
                unfinishedId,
                optedOutId,
                oldId,
                busyChildId,
                pinnedId,
                `${childDoneId}:child`,
                `${childOpenId}:child`,
              ],
              conversationIds: [unfinishedId, `${childOpenId}:child`],
              finishedWorkAtByConversationId: {
                [`${childDoneId}:child`]: finishedAt,
                [busyChildId]: finishedAt,
                [pinnedId]: finishedAt,
                [doneId]: finishedAt,
                [optedOutId]: finishedAt,
                [oldId]: new Date(nowMs - 29 * 24 * hour).toISOString(),
              },
            }),
          },
        }),
      ]),
    });
    const sweep = async () => {
      const response = await juniorApp.request(
        `http://localhost${JUNIOR_AUTO_ARCHIVE_ROUTE}`,
        { headers: { authorization: "Bearer auto-archive-secret" } },
      );
      expect(response.status).toBe(200);
      return await response.json();
    };

    const { app } = await authenticatedApi(viewer.email);
    const detailUrl = `http://localhost/api/conversations/${optedOutId}`;
    const beforeEtag = (await app.request(detailUrl)).headers.get(
      CONVERSATION_DETAIL_VERSION_HEADER,
    )!;
    const optOut = await app.request(
      `http://localhost/api/conversations/${optedOutId}/auto-archive`,
      {
        body: JSON.stringify({ autoArchive: false }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(optOut.status).toBe(200);
    expect(conversationAutoArchiveSchema.parse(await optOut.json())).toEqual({
      autoArchive: false,
    });
    // An open details panel refetches the new choice instead of a 304.
    expect(
      (
        await app.request(detailUrl, {
          headers: { [CONVERSATION_DETAIL_VERSION_HEADER]: beforeEtag },
        })
      ).status,
    ).toBe(200);
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(optedOutId, { viewer }),
      ).autoArchive,
    ).toBe(false);

    await expect(sweep()).resolves.toEqual({
      archived: 4,
      scanned: 7,
    });
    const archivedIds = async (userId: string) =>
      (
        await getDb()
          .select({
            archivedAt: juniorConversationParticipants.archivedAt,
            rootConversationId:
              juniorConversationParticipants.rootConversationId,
          })
          .from(juniorConversationParticipants)
          .where(eq(juniorConversationParticipants.userId, userId))
      )
        .filter((row) => row.archivedAt)
        .map((row) => row.rootConversationId);
    await expect(
      archivedIds(viewer.id).then((ids) => ids.sort()),
    ).resolves.toEqual([oldId, doneId, noWorkId, childDoneId].sort());
    await expect(archivedIds(otherViewer.id)).resolves.toEqual([]);

    // A manual restore turns auto-archive off, so the next sweep keeps it.
    const restore = await app.request(
      `http://localhost/api/conversations/${doneId}/archive`,
      {
        body: JSON.stringify({
          archived: false,
          lastSeenAt: new Date(nowMs - 48 * hour).toISOString(),
        }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      },
    );
    expect(restore.status).toBe(200);
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(doneId, { viewer }),
      ).autoArchive,
    ).toBe(false);
    await sweep();
    await expect(
      archivedIds(viewer.id).then((ids) => ids.sort()),
    ).resolves.toEqual([oldId, noWorkId, childDoneId].sort());
  });

  it("archives nothing when a plugin cannot report work", async () => {
    const nowMs = Date.now();
    const conversationId = "local:test:archive-done-plugin-failed";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      conversationId,
      nowMs: nowMs - 60_000,
      source: "internal",
    });
    const viewer = await addParticipant({
      conversationId,
      email: "archive-failed@example.com",
      lastMessageAt: new Date(nowMs - 60_000),
    });
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "work",
            displayName: "Work",
            description: "Failing work test plugin",
          },
          hooks: {
            unfinishedWork: () => {
              throw new Error("provider unavailable");
            },
          },
        }),
      ]),
    });

    const { app } = await authenticatedApi(viewer.email);
    const response = await app.request(
      "http://localhost/api/conversations/archive-done",
      { method: "POST" },
    );
    expect(
      archiveDoneConversationsResponseSchema.parse(await response.json()),
    ).toEqual({ archived: 0 });
  });

  it("archives the viewer's done conversations once on request", async () => {
    const nowMs = Date.now();
    const doneId = "local:test:archive-done-now";
    const waitingId = "local:test:archive-done-waiting";
    const optedOutId = "local:test:archive-done-opted-out";
    const unfinishedId = "local:test:archive-done-unfinished";
    const recentId = "local:test:archive-done-recent";
    const ids = [doneId, waitingId, optedOutId, unfinishedId, recentId];
    // Past the default 24-hour wait time.
    const staleMs = nowMs - 25 * 60 * 60 * 1000;
    const activityMsById = (id: string) =>
      id === recentId ? nowMs - 60_000 : staleMs;
    for (const conversationId of ids) {
      await getConversationStore().recordActivity({
        destination: { platform: "local" as const, conversationId },
        conversationId,
        nowMs: activityMsById(conversationId),
        source: "internal",
      });
    }
    const viewer = await addParticipant({
      conversationId: doneId,
      email: "archive-now@example.com",
      lastMessageAt: new Date(staleMs),
    });
    for (const conversationId of ids.slice(1)) {
      await getDb()
        .insert(juniorConversationParticipants)
        .values({
          autoArchive: conversationId === optedOutId ? false : null,
          lastMessageAt: new Date(activityMsById(conversationId)),
          rootConversationId: conversationId,
          userId: viewer.id,
        });
    }
    // An open action item for the viewer keeps the conversation in the feed.
    await insertReviewItem(getDb(), {
      addedByConversationId: waitingId,
      assignedToEveryone: false,
      assigneeUserIds: [viewer.id],
      body: "Merge or close the follow-up?",
      conversationIds: [waitingId],
      dedupeKey: "archive-done:waiting",
      kind: "action",
      nowMs,
      request: {
        fields: [
          {
            id: "decision",
            kind: "choice",
            label: "Decision",
            options: [{ label: "Merge" }, { label: "Close" }],
          },
        ],
        question: "Merge or close the follow-up?",
      },
      title: "Follow-up",
      visibility: "private",
    });
    // The manual run waits the same time as the scheduled sweep. The recent
    // conversation has no work but had activity a minute ago, so it stays.
    const finishedAt = new Date(staleMs).toISOString();
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "work",
            displayName: "Work",
            description: "Archive-done work test plugin",
          },
          hooks: {
            unfinishedWork: () => ({
              assignedConversationIds: ids,
              conversationIds: [unfinishedId],
              finishedWorkAtByConversationId: {
                [doneId]: finishedAt,
                [optedOutId]: finishedAt,
                [waitingId]: finishedAt,
              },
            }),
          },
        }),
      ]),
    });

    const { app } = await authenticatedApi(viewer.email);
    const response = await app.request(
      "http://localhost/api/conversations/archive-done",
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    expect(
      archiveDoneConversationsResponseSchema.parse(await response.json()),
    ).toEqual({ archived: 1 });
    // The waiting conversation stays in the feed after it falls out of the
    // newest page, so Needs attention can show it.
    const feed = await readConversationFeedFromSql({ limit: 1, viewer });
    expect(
      feed.conversations.map((conversation) => conversation.conversationId),
    ).toEqual([recentId, waitingId]);
    const fullFeed = await readConversationFeedFromSql({ viewer });
    expect(
      fullFeed.conversations
        .map((conversation) => conversation.conversationId)
        .sort(),
    ).toEqual([optedOutId, recentId, unfinishedId, waitingId].sort());
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(doneId, { viewer }),
      ).archivedAt,
    ).toEqual(expect.any(String));
  });
});
