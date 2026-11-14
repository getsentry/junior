import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationDetail } from "@/api/conversations/detail";
import {
  readConversationFeed,
  readConversationFeedFromSql,
} from "@/api/conversations/list";
import type { JuniorApiEnv } from "@/api/route";
import {
  apiErrorSchema,
  archiveConversationResponseSchema,
  conversationDetailReportSchema,
} from "@/api/schema";
import { webActorFromUser } from "@/chat/conversations/web-input";
import {
  closeDb,
  getConversationEventStore,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

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

  it("archives a conversation for everyone and exposes archivedAt on detail", async () => {
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
    // Archive applies to everyone, so another participant sees it archived.
    for (const feedViewer of [viewer, otherViewer]) {
      await expect(
        readConversationFeed({ viewer: feedViewer }),
      ).resolves.toMatchObject({ conversations: [] });
      expect(
        conversationDetailReportSchema.parse(
          await readConversationDetail(conversationId, { viewer: feedViewer }),
        ).archivedAt,
      ).toEqual(expect.any(String));
    }

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
    await expect(
      readConversationFeed({ viewer: otherViewer }),
    ).resolves.toMatchObject({
      conversations: [expect.objectContaining({ conversationId })],
    });
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer }),
      ).archivedAt,
    ).toBeNull();
  });

  it("archives a Conversation and its children for everyone", async () => {
    const rootId = "local:test:thread-archive-root";
    const threadId = "agent:thread-archive-thread";
    const taskId = "agent:thread-archive-task";
    const taskThreadId = "agent:thread-archive-task-thread";
    const taskThreadTaskId = "agent:thread-archive-task-thread-task";
    // A Thread below a deep Task chain still nests under the root.
    const taskChain = Array.from(
      { length: 12 },
      (_, index) => `agent:thread-archive-task-${index}`,
    );
    const deepTaskId = taskChain.at(-1)!;
    const lastSeenAt = "1970-01-01T00:00:01.000Z";
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId: rootId },
      conversationId: rootId,
      nowMs: Date.parse(lastSeenAt),
      source: "internal",
      title: "Thread archive",
    });
    // Only spawnAgent creates children today, and always as Tasks.
    for (const [childConversationId, parentConversationId, kind, nowMs] of [
      [threadId, rootId, "thread", 2_000],
      [taskId, rootId, "task", 3_000],
      ...taskChain.map(
        (id, index) =>
          [id, taskChain[index - 1] ?? taskId, "task", 3_000] as const,
      ),
      [taskThreadId, deepTaskId, "thread", 4_000],
      [taskThreadTaskId, taskThreadId, "task", 4_000],
    ] as const) {
      await getConversationStore().createChild({
        childConversationId,
        kind,
        nowMs,
        parentConversationId,
      });
    }
    const viewer = await addParticipant({
      conversationId: rootId,
      email: "thread-viewer@example.com",
      lastMessageAt: new Date(lastSeenAt),
    });
    const otherViewer = await addParticipant({
      conversationId: rootId,
      email: "thread-other@example.com",
      lastMessageAt: new Date(lastSeenAt),
    });
    const { app } = await authenticatedApi(viewer.email);
    const archive = (
      conversationId: string,
      archived: boolean,
      at: string,
      applyToChildren?: boolean,
    ) =>
      app.request(
        `http://localhost/api/conversations/${conversationId}/archive`,
        {
          body: JSON.stringify({ applyToChildren, archived, lastSeenAt: at }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
    const feedThreads = async (feedViewer: typeof viewer) =>
      (await readConversationFeed({ viewer: feedViewer })).conversations.map(
        (conversation) => ({
          conversationId: conversation.conversationId,
          threads: conversation.threads?.map((thread) => ({
            conversationId: thread.conversationId,
            kind: thread.kind,
            parentConversationId: thread.parentConversationId,
            archivedAt: thread.archivedAt,
          })),
        }),
      );

    // A Thread under a Task nests under the root. Tasks never show.
    const visibleThreads = [
      {
        conversationId: taskThreadId,
        kind: "thread",
        parentConversationId: deepTaskId,
        archivedAt: null,
      },
      {
        conversationId: threadId,
        kind: "thread",
        parentConversationId: rootId,
        archivedAt: null,
      },
    ];
    await expect(feedThreads(viewer)).resolves.toEqual([
      { conversationId: rootId, threads: visibleThreads },
    ]);

    // A Thread uses the access of its root. A non-member gets neither the
    // private root nor its Threads, and a feed read for another person
    // redacts Thread titles.
    await getDb()
      .update(juniorConversations)
      .set({ title: "Thread secret plan" })
      .where(eq(juniorConversations.conversationId, threadId));
    const outsider = await resolveViewerUser("thread-outsider@example.com");
    if (!outsider) throw new Error("missing outsider viewer");
    const feedTitles = async (
      options: Parameters<typeof readConversationFeedFromSql>[0],
    ) =>
      (await readConversationFeedFromSql(options)).conversations.map(
        (conversation) => ({
          displayTitle: conversation.displayTitle,
          threads: conversation.threads?.map((thread) => thread.displayTitle),
        }),
      );
    await expect(feedTitles({ viewer })).resolves.toEqual([
      {
        displayTitle: "Thread archive",
        threads: [expect.any(String), "Thread secret plan"],
      },
    ]);
    await expect(feedTitles({ viewer: outsider })).resolves.toEqual([]);
    await expect(feedTitles({ actorEmail: viewer.email })).resolves.toEqual([
      {
        displayTitle: "Private Conversation",
        threads: ["Private Conversation", "Private Conversation"],
      },
    ]);
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(threadId, { viewer: outsider }),
      ).displayTitle,
    ).toBe("Private Conversation");

    const lastSeen = async (conversationId: string) =>
      conversationDetailReportSchema.parse(
        await readConversationDetail(conversationId, { viewer }),
      ).lastSeenAt;
    const readChildRows = () =>
      getDb()
        .select({
          archivedAt: juniorConversations.archivedAt,
          conversationId: juniorConversations.conversationId,
          detailVersion: juniorConversations.detailVersion,
        })
        .from(juniorConversations)
        .where(
          and(
            eq(juniorConversations.rootConversationId, rootId),
            isNotNull(juniorConversations.parentConversationId),
          ),
        )
        .orderBy(juniorConversations.conversationId);
    const archivedChildIds = async () =>
      (await readChildRows())
        .filter((row) => row.archivedAt)
        .map((row) => row.conversationId)
        .sort();
    const taskSubtree = [
      taskId,
      ...taskChain,
      taskThreadId,
      taskThreadTaskId,
    ].sort();

    expect((await archive(threadId, true, lastSeenAt)).status).toBe(409);
    // A child archive refuses while a descendant is unarchived, unless the
    // caller also archives them.
    const refusedTask = await archive(taskId, true, await lastSeen(taskId));
    expect(refusedTask.status).toBe(409);
    await expect(refusedTask.json()).resolves.toEqual({
      error:
        "14 child conversations are not archived. Pass applyToChildren to archive them too.",
    });
    await expect(archivedChildIds()).resolves.toEqual([]);

    // A Thread with no children archives for everyone without the flag.
    const archivedThread = await archive(
      threadId,
      true,
      await lastSeen(threadId),
    );
    expect(archivedThread.status).toBe(200);
    const { archivedAt: threadArchivedAt } =
      archiveConversationResponseSchema.parse(await archivedThread.json());
    expect(threadArchivedAt).toEqual(expect.any(String));
    for (const feedViewer of [viewer, otherViewer]) {
      await expect(feedThreads(feedViewer)).resolves.toEqual([
        { conversationId: rootId, threads: [visibleThreads[0]] },
      ]);
    }
    expect(
      conversationDetailReportSchema.parse(
        await readConversationDetail(threadId, { viewer: otherViewer }),
      ),
    ).toMatchObject({
      archivedAt: threadArchivedAt,
      kind: "thread",
      parentConversationId: rootId,
    });

    // A leaf under the Task archived on its own keeps its own archive.
    const archivedLeaf = await archive(
      taskThreadTaskId,
      true,
      await lastSeen(taskThreadTaskId),
    );
    expect(archivedLeaf.status).toBe(200);
    const { archivedAt: leafArchivedAt } =
      archiveConversationResponseSchema.parse(await archivedLeaf.json());
    const leafArchiveTime = async () =>
      (await readChildRows())
        .find((row) => row.conversationId === taskThreadTaskId)
        ?.archivedAt?.toISOString();
    // applyToChildren archives the Task and every descendant for everyone,
    // with one time for everything that this archive wrote.
    const archivedTask = await archive(
      taskId,
      true,
      await lastSeen(taskId),
      true,
    );
    expect(archivedTask.status).toBe(200);
    const { archivedAt: taskArchivedAt } =
      archiveConversationResponseSchema.parse(await archivedTask.json());
    await expect(archivedChildIds()).resolves.toEqual(
      [threadId, ...taskSubtree].sort(),
    );
    const subtreeTimes = new Set(
      (await readChildRows())
        .filter(
          (row) =>
            taskSubtree.includes(row.conversationId) &&
            row.conversationId !== taskThreadTaskId,
        )
        .map((row) => row.archivedAt?.toISOString()),
    );
    expect([...subtreeTimes]).toEqual([taskArchivedAt]);
    await expect(leafArchiveTime()).resolves.toBe(leafArchivedAt);
    for (const feedViewer of [viewer, otherViewer]) {
      await expect(feedThreads(feedViewer)).resolves.toEqual([
        { conversationId: rootId, threads: undefined },
      ]);
    }

    // A restore under an archived ancestor names the one to restore first.
    const refusedRestore = await archive(deepTaskId, false, lastSeenAt);
    expect(refusedRestore.status).toBe(409);
    await expect(refusedRestore.json()).resolves.toEqual({
      error: `Conversation ${taskId} above this one is archived. Restore it first.`,
    });
    // Without the flag, a restore changes only the given child.
    expect((await archive(taskId, false, lastSeenAt)).status).toBe(200);
    await expect(archivedChildIds()).resolves.toEqual(
      [threadId, ...taskSubtree.filter((id) => id !== taskId)].sort(),
    );
    await expect(feedThreads(viewer)).resolves.toEqual([
      { conversationId: rootId, threads: undefined },
    ]);
    // With the flag, a restore also restores the descendants archived with
    // the child. The leaf archived before them keeps its archive and time.
    expect((await archive(taskChain[0]!, false, lastSeenAt, true)).status).toBe(
      200,
    );
    await expect(archivedChildIds()).resolves.toEqual(
      [threadId, taskThreadTaskId].sort(),
    );
    await expect(leafArchiveTime()).resolves.toBe(leafArchivedAt);
    await expect(feedThreads(viewer)).resolves.toEqual([
      { conversationId: rootId, threads: [visibleThreads[0]] },
    ]);

    // A root follows the same rules: it refuses while a descendant is
    // unarchived, and the flag archives the tree for everyone.
    const refusedRoot = await archive(rootId, true, lastSeenAt);
    expect(refusedRoot.status).toBe(409);
    await expect(refusedRoot.json()).resolves.toEqual({
      error:
        "14 child conversations are not archived. Pass applyToChildren to archive them too.",
    });
    expect((await archive(rootId, true, lastSeenAt, true)).status).toBe(200);
    for (const feedViewer of [viewer, otherViewer]) {
      await expect(feedThreads(feedViewer)).resolves.toEqual([]);
    }
    // A cascade restore of the root leaves the Thread and the leaf, which
    // were archived before, archived.
    expect((await archive(rootId, false, lastSeenAt, true)).status).toBe(200);
    await expect(archivedChildIds()).resolves.toEqual(
      [threadId, taskThreadTaskId].sort(),
    );
    for (const feedViewer of [viewer, otherViewer]) {
      await expect(feedThreads(feedViewer)).resolves.toEqual([
        { conversationId: rootId, threads: [visibleThreads[0]] },
      ]);
    }

    const startTurn = (
      conversationId: string,
      messageId: string,
      message: {
        authorIdentityId?: string | undefined;
        meta?: Record<string, unknown>;
        text: string;
      },
      createdAtMs: number,
    ) =>
      getConversationEventStore().append(conversationId, [
        {
          createdAtMs,
          data: { ...message, messageId, role: "user", type: "message" },
          idempotencyKey: `message:${messageId}`,
        },
        {
          createdAtMs,
          data: {
            inputMessageIds: [messageId],
            surface: "api",
            turnId: `${messageId}:turn`,
            type: "turn_started",
          },
          idempotencyKey: `turn:${messageId}:started`,
        },
      ]);
    // Archive the whole tree, so the Thread has archived ancestors up to the
    // root and an archived child.
    expect((await archive(rootId, true, lastSeenAt, true)).status).toBe(200);
    const archivedTree = [threadId, ...taskSubtree].sort();
    await expect(archivedChildIds()).resolves.toEqual(archivedTree);

    // The parent agent's input, as recordSubagentStarted stores it, is not a
    // person's message.
    await startTurn(
      taskThreadId,
      "thread-archive-invocation",
      { meta: { agentInvocationId: "invocation-1" }, text: "Keep going." },
      5_000,
    );
    await expect(archivedChildIds()).resolves.toEqual(archivedTree);
    await expect(feedThreads(viewer)).resolves.toEqual([]);

    // A person's message restores the Thread and its archived ancestors,
    // the root too, for everyone. Its archived child stays archived.
    await startTurn(
      taskThreadId,
      "thread-archive-message",
      {
        authorIdentityId: await resolveActorIdentityId(
          getSqlExecutor(),
          webActorFromUser(otherViewer),
        ),
        text: "picking this back up",
      },
      6_000,
    );
    await expect(archivedChildIds()).resolves.toEqual(
      [threadId, taskThreadTaskId].sort(),
    );
    for (const feedViewer of [viewer, otherViewer]) {
      await expect(feedThreads(feedViewer)).resolves.toEqual([
        { conversationId: rootId, threads: [visibleThreads[0]] },
      ]);
    }

    // A Thread created under an archived Task has no archive of its own, but
    // its archived ancestor still hides it.
    const lateTaskId = "agent:thread-archive-late-task";
    await getConversationStore().createChild({
      childConversationId: lateTaskId,
      kind: "task",
      nowMs: 7_000,
      parentConversationId: rootId,
    });
    expect(
      (await archive(lateTaskId, true, await lastSeen(lateTaskId))).status,
    ).toBe(200);
    await getConversationStore().createChild({
      childConversationId: "agent:thread-archive-late-thread",
      kind: "thread",
      nowMs: 8_000,
      parentConversationId: lateTaskId,
    });
    await expect(feedThreads(viewer)).resolves.toEqual([
      { conversationId: rootId, threads: [visibleThreads[0]] },
    ]);
  });

  it("makes a root Actor a Participant when their Identity gets its User later", async () => {
    const conversationId = "local:test:archive-root-actor";
    const lastSeenAt = "1970-01-01T00:00:02.000Z";
    const email = "root-actor@example.com";
    const slackActor = {
      platform: "slack" as const,
      slackUserId: "UROOT",
      teamId: "T1",
    };
    // Slack sent no email, so the Identity that starts the root has no User.
    await getConversationStore().recordActivity({
      destination: { platform: "local" as const, conversationId },
      actor: slackActor,
      conversationId,
      nowMs: Date.parse(lastSeenAt),
      source: "slack",
      title: "Root actor archive",
    });
    // A later Turn from the same Slack account links it to a User.
    await getConversationStore().recordActivity({
      destination: {
        platform: "local" as const,
        conversationId: "local:test:archive-root-actor-later",
      },
      actor: { ...slackActor, email },
      conversationId: "local:test:archive-root-actor-later",
      nowMs: Date.parse(lastSeenAt),
      source: "slack",
      title: "Later root",
    });

    const viewer = (await resolveViewerUser(email))!;
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
});
