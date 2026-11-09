import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { User } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { boardReportSchema } from "@/api/schema";
import { recordCodeChange } from "@/chat/code/store";
import { closeDb, getConversationStore, getDb } from "@/chat/db";
import { createPluginAnnotations } from "@/chat/plugins/annotations";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { createPluginReviewItems } from "@/chat/review-items/plugin";
import { insertReviewItem } from "@/chat/review-items/store";
import {
  juniorConversationParticipants,
  juniorConversations,
} from "@/db/schema";

const NOW = Date.parse("2026-10-01T12:00:00.000Z");
const HOUR = 60 * 60 * 1_000;
const ROOT = "slack:C1:1.000001";
const THREAD = "agent:thread-1";
const TASK = "agent:task-1";
const NEWER_THREAD = "agent:thread-2";
const ARCHIVED_THREAD = "agent:thread-archived";
const OTHER_ROOT = "slack:C1:2.000001";

async function rootConversation(conversationId: string, title: string) {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "C1" },
    nowMs: NOW - 2 * HOUR,
    source: "slack",
    title,
    visibility: "public",
  });
}

async function participant(rootConversationId: string, user: User) {
  await getDb()
    .insert(juniorConversationParticipants)
    .values({
      lastMessageAt: new Date(NOW - HOUR),
      rootConversationId,
      userId: user.id,
    });
}

async function codeChange(args: {
  conversationIds: string[];
  mergedAt?: Date;
  number: number;
  state: "open" | "merged" | "closed";
}) {
  await recordCodeChange(getDb(), "github", {
    conversationIds: args.conversationIds,
    ...(args.mergedAt ? { mergedAt: args.mergedAt } : undefined),
    ...(args.state === "closed"
      ? { closedAt: new Date(NOW - HOUR) }
      : undefined),
    number: args.number,
    openedAt: new Date(NOW - 48 * HOUR),
    providerId: `pr-${args.number}`,
    repository: {
      name: "getsentry/junior",
      providerId: "repository-1",
      url: "https://github.com/getsentry/junior",
    },
    state: args.state,
    title: `Change ${args.number}`,
    updatedAt: new Date(NOW - 2 * HOUR),
    url: `https://github.com/getsentry/junior/pull/${args.number}`,
  });
}

async function ticket(conversationId: string, number: number, status: string) {
  await createPluginAnnotations({
    conversationId,
    db: getDb(),
    plugin: "github",
  }).upsert({
    kind: "object",
    key: `getsentry/junior#${number}`,
    label: `getsentry/junior#${number}`,
    objectType: "task",
    status,
    title: `Ticket ${number}`,
    url: `https://github.com/getsentry/junior/issues/${number}`,
  });
}

async function boardFor(viewer: User) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const response = await app.request("http://localhost/api/board");
  expect(response.status).toBe(200);
  return boardReportSchema.parse(await response.json());
}

describe("board API", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await closeDb();
  });

  it("puts each object of the viewer's Conversations in one column", async () => {
    vi.setSystemTime(NOW);
    const viewer = await resolveViewerUserFromSql(getDb(), "ana@example.com");
    const other = await resolveViewerUserFromSql(getDb(), "bo@example.com");
    if (!viewer || !other) throw new Error("missing users");

    await rootConversation(ROOT, "Fix uploads");
    await participant(ROOT, viewer);
    await getConversationStore().createChild({
      childConversationId: THREAD,
      kind: "thread",
      nowMs: NOW - HOUR,
      parentConversationId: ROOT,
    });
    await getDb()
      .update(juniorConversations)
      .set({ title: "Retry logic" })
      .where(eq(juniorConversations.conversationId, THREAD));
    await getConversationStore().createChild({
      childConversationId: NEWER_THREAD,
      kind: "thread",
      nowMs: NOW - HOUR / 2,
      parentConversationId: ROOT,
    });
    await getConversationStore().createChild({
      childConversationId: TASK,
      kind: "task",
      nowMs: NOW - HOUR / 4,
      parentConversationId: THREAD,
    });
    await getDb()
      .update(juniorConversations)
      .set({ executionStatus: "running" })
      .where(eq(juniorConversations.conversationId, TASK));
    await getConversationStore().createChild({
      childConversationId: ARCHIVED_THREAD,
      kind: "thread",
      nowMs: NOW - HOUR,
      parentConversationId: ROOT,
    });
    await getDb()
      .update(juniorConversations)
      .set({ archivedAt: new Date(NOW - HOUR) })
      .where(eq(juniorConversations.conversationId, ARCHIVED_THREAD));
    await rootConversation(OTHER_ROOT, "Someone else");
    await participant(OTHER_ROOT, other);

    // A Task's change shows on its Thread, which is running. The Thread is
    // older than the other linked Thread, though the Task is newer.
    await codeChange({
      conversationIds: [TASK, NEWER_THREAD],
      number: 1,
      state: "open",
    });
    // Linked to two Conversations, still one card, on the older one. The
    // stored links sort the Thread first.
    await codeChange({
      conversationIds: [ROOT, THREAD],
      number: 2,
      state: "open",
    });
    await codeChange({
      conversationIds: [ROOT],
      mergedAt: new Date(NOW - HOUR),
      number: 3,
      state: "merged",
    });
    await codeChange({
      conversationIds: [ROOT],
      mergedAt: new Date(NOW - 48 * HOUR),
      number: 4,
      state: "merged",
    });
    await codeChange({ conversationIds: [ROOT], number: 5, state: "closed" });
    await codeChange({
      conversationIds: [ARCHIVED_THREAD],
      number: 6,
      state: "open",
    });
    await codeChange({
      conversationIds: [OTHER_ROOT],
      number: 7,
      state: "open",
    });

    // Only a plugin notice makes a change ready. An agent's item about the
    // same change does not, but it needs the viewer.
    await createPluginReviewItems({
      conversationId: ROOT,
      plugin: "github",
      show: async () => {},
    }).upsert({
      assigneeIdentityIds: [],
      body: "Approved and mergeable.",
      dedupeKey: "pull-request-ready:getsentry/junior#2",
      subject: {
        id: "https://github.com/getsentry/junior/pull/2",
        title: "getsentry/junior#2",
        url: "https://github.com/getsentry/junior/pull/2",
      },
      title: "Ready to merge: getsentry/junior#2",
    });
    await insertReviewItem(getDb(), {
      addedByConversationId: THREAD,
      assignedToEveryone: false,
      assigneeUserIds: [viewer.id],
      body: "Should this retry twice?",
      conversationIds: [THREAD],
      dedupeKey: "retry-count",
      kind: "action",
      nowMs: NOW,
      request: {
        fields: [
          {
            id: "decision",
            kind: "choice",
            label: "Decision",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
        question: "Retry twice?",
      },
      subject: {
        id: "https://github.com/getsentry/junior/pull/1",
        title: "getsentry/junior#1",
        url: "https://github.com/getsentry/junior/pull/1",
      },
      title: "Retry count",
      visibility: "public",
    });

    // The same ticket in two Conversations: the newest state wins, and the
    // card stays where the ticket began.
    vi.setSystemTime(NOW - 3 * HOUR);
    await ticket(ROOT, 10, "open");
    await ticket(ROOT, 11, "open");
    await ticket(ROOT, 12, "In Review");
    // Archiving the Conversation where a ticket began keeps it on the Board.
    await ticket(ARCHIVED_THREAD, 14, "open");
    await ticket(ROOT, 14, "open");
    // A running Task puts its Thread's open ticket in progress.
    await ticket(TASK, 13, "open");
    vi.setSystemTime(NOW - HOUR);
    await ticket(THREAD, 10, "closed");
    vi.setSystemTime(NOW);

    const board = await boardFor(viewer);
    const columns = Object.fromEntries(
      board.cards.map((card) => [card.label, card.column]),
    );
    expect(columns).toEqual({
      "getsentry/junior#1": "in_progress",
      "getsentry/junior#2": "ready",
      "getsentry/junior#3": "done",
      "getsentry/junior#10": "done",
      "getsentry/junior#11": "planned",
      "getsentry/junior#13": "in_progress",
      "getsentry/junior#14": "planned",
    });
    expect(new Set(board.cards.map((card) => card.key)).size).toBe(
      board.cards.length,
    );

    const byLabel = new Map(board.cards.map((card) => [card.label, card]));
    expect(byLabel.get("getsentry/junior#1")).toMatchObject({
      conversation: {
        conversationId: THREAD,
        rootTitle: "Fix uploads",
        title: "Retry logic",
      },
      needsViewer: true,
      working: true,
    });
    expect(byLabel.get("getsentry/junior#2")).toMatchObject({
      conversation: { conversationId: ROOT, title: "Fix uploads" },
      needsViewer: false,
      working: false,
    });
    expect(
      byLabel.get("getsentry/junior#10")?.conversation.conversationId,
    ).toBe(ROOT);
    expect(
      byLabel.get("getsentry/junior#14")?.conversation.conversationId,
    ).toBe(ROOT);

    expect((await boardFor(other)).cards.map((card) => card.label)).toEqual([
      "getsentry/junior#7",
    ]);
  });
});
