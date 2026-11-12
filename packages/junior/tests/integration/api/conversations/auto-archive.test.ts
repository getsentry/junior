import { CONVERSATION_DETAIL_VERSION_HEADER } from "@/api/schema";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { createJuniorApi } from "@/api";
import { updateUserAutoArchiveSettings } from "@/api/conversations/auto-archive";
import { createApp } from "@/app";
import { readConversationDetail } from "@/api/conversations/detail";
import { readConversationFeedFromSql } from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  archiveDoneConversationsResponseSchema,
  conversationAutoArchiveSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { insertReviewItem } from "@/chat/review-items/store";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { JUNIOR_AUTO_ARCHIVE_ROUTE } from "@/deployment";
import { defineJuniorPlugins } from "@/plugins";
import { isNotNull } from "drizzle-orm";

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

describe("conversation auto-archive API", () => {
  afterEach(async () => {
    delete process.env.JUNIOR_SCHEDULER_SECRET;
    await closeDb();
  });

  it("auto-archives finished work for everyone after one viewer's grace period and respects per-conversation choices", async () => {
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
        kind: "task",
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
    // This viewer was active 30 hours ago, inside their 36-hour grace period.
    const otherViewer = await addParticipant({
      conversationId: doneId,
      email: "manual@example.com",
      lastMessageAt: new Date(nowMs - 30 * hour),
    });
    await updateUserAutoArchiveSettings(viewer.id, {
      autoArchiveDefault: true,
    });
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
      scanned: 6,
    });
    const archivedIds = async () =>
      (
        await getDb()
          .select({ conversationId: juniorConversations.conversationId })
          .from(juniorConversations)
          .where(isNotNull(juniorConversations.archivedAt))
      )
        .map((row) => row.conversationId)
        .sort();
    await expect(archivedIds()).resolves.toEqual(
      [oldId, doneId, noWorkId, childDoneId].sort(),
    );
    // One viewer's grace period passed, so the root is archived for the
    // other participant too.
    await expect(
      readConversationFeedFromSql({ viewer: otherViewer }),
    ).resolves.toMatchObject({ conversations: [] });

    // The other participant's manual restore turns auto-archive off for
    // them, so this viewer's next sweep keeps it for everyone.
    const { app: otherApp } = await authenticatedApi(otherViewer.email);
    const restore = await otherApp.request(
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
        await readConversationDetail(doneId, { viewer: otherViewer }),
      ).autoArchive,
    ).toBe(false);
    // The sweep reads only rows on unarchived roots.
    await expect(sweep()).resolves.toEqual({ archived: 0, scanned: 2 });
    await expect(archivedIds()).resolves.toEqual(
      [oldId, noWorkId, childDoneId].sort(),
    );
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

  it("keeps a conversation that waits on a person to finish an authorization", async () => {
    const nowMs = Date.now();
    const hour = 60 * 60 * 1000;
    const connectingId = "local:test:archive-auth-connecting";
    // A person's message in a Thread asked for the connection.
    const childConnectingId = "local:test:archive-auth-child-connecting";
    const connectedId = "local:test:archive-auth-connected";
    // The connect link expired before anyone used it.
    const expiredId = "local:test:archive-auth-expired";
    const ids = [connectingId, childConnectingId, connectedId, expiredId];
    const requestedMsById = (id: string) =>
      id === expiredId ? nowMs - 25 * hour : nowMs - 3 * hour;
    for (const conversationId of ids) {
      await getConversationStore().recordActivity({
        destination: { platform: "local" as const, conversationId },
        conversationId,
        nowMs: requestedMsById(conversationId),
        source: "internal",
      });
    }
    await getConversationStore().createChild({
      childConversationId: `${childConnectingId}:child`,
      kind: "thread",
      nowMs: nowMs - 3 * hour,
      parentConversationId: childConnectingId,
    });
    const requestedIn = async (conversationId: string, createdAtMs: number) => {
      const authorizationId = `${conversationId}:turn:mcp:linear`;
      await getConversationEventStore().append(conversationId, [
        {
          data: {
            type: "turn_started",
            turnId: `${conversationId}:turn`,
            inputMessageIds: [`${conversationId}:message`],
            surface: "api",
          },
          createdAtMs: createdAtMs - 60_000,
        },
        {
          data: {
            type: "authorization_requested",
            kind: "mcp",
            provider: "linear",
            actorId: "identity:archive-auth",
            authorizationId,
            delivery: "private_link_sent",
          },
          createdAtMs,
        },
      ]);
      return authorizationId;
    };
    await requestedIn(connectingId, nowMs - 3 * hour);
    await requestedIn(`${childConnectingId}:child`, nowMs - 3 * hour);
    await requestedIn(expiredId, nowMs - 25 * hour);
    const connectedAuthorizationId = await requestedIn(
      connectedId,
      nowMs - 3 * hour,
    );
    await getConversationEventStore().append(connectedId, [
      {
        data: {
          type: "authorization_completed",
          kind: "mcp",
          provider: "linear",
          actorId: "identity:archive-auth",
          authorizationId: connectedAuthorizationId,
        },
        createdAtMs: nowMs - 3 * hour + 60_000,
      },
    ]);
    const viewer = await addParticipant({
      conversationId: connectingId,
      email: "archive-auth@example.com",
      lastMessageAt: new Date(nowMs - 3 * hour),
    });
    for (const conversationId of ids.slice(1)) {
      await getDb()
        .insert(juniorConversationParticipants)
        .values({
          lastMessageAt: new Date(requestedMsById(conversationId)),
          rootConversationId: conversationId,
          userId: viewer.id,
        });
    }
    await updateUserAutoArchiveSettings(viewer.id, {
      autoArchiveGraceHours: 1,
    });
    await createApp({ dashboard: { disabled: true } });

    // The Turn parked for the connection leaves every conversation idle and
    // quiet, but the feed shows the waits that have not expired.
    const feed = await readConversationFeedFromSql({ viewer });
    expect(
      Object.fromEntries(
        feed.conversations.map((conversation) => [
          conversation.conversationId,
          conversation.awaitingAuthorization ?? false,
        ]),
      ),
    ).toEqual({
      [childConnectingId]: true,
      [connectedId]: false,
      [connectingId]: true,
      [expiredId]: false,
    });

    const { app } = await authenticatedApi(viewer.email);
    const response = await app.request(
      "http://localhost/api/conversations/archive-done",
      { method: "POST" },
    );
    expect(
      archiveDoneConversationsResponseSchema.parse(await response.json()),
    ).toEqual({ archived: 2 });
    const remaining = await readConversationFeedFromSql({ viewer });
    expect(
      remaining.conversations
        .map((conversation) => conversation.conversationId)
        .sort(),
    ).toEqual([childConnectingId, connectingId].sort());
  });
});
