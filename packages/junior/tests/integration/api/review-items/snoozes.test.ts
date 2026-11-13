import { createMemoryState } from "@chat-adapter/state-memory";
import { githubPlugin } from "@sentry/junior-github";
import type { User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { insertReviewItem } from "@/chat/review-items/store";
import { juniorAutomations } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";

const ROOT = "slack:CSNOOZE:1.000001";
const PRIVATE_ROOT = "slack:CSNOOZE:2.000001";
const PR = "getsentry/junior#7";
const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");

/** A dashboard User with one linked Slack identity. */
async function user(email: string): Promise<User> {
  const created = await resolveViewerUserFromSql(getDb(), email);
  if (!created) throw new Error(`no user for ${email}`);
  await upsertLinkedIdentity(getSqlExecutor(), created.id, {
    kind: "user",
    provider: "slack",
    providerSubjectId: `U-${email}`,
    providerTenantId: "T123",
  });
  return (await resolveViewerUserFromSql(getDb(), email))!;
}

async function conversation(
  conversationId: string,
  visibility: "private" | "public",
): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "CSNOOZE" },
    nowMs: NOW_MS,
    source: "slack",
    visibility,
  });
}

async function addItem(
  conversationId: string,
  assignees: User[],
  title: string,
  visibility: "private" | "public" = "public",
): Promise<string> {
  const item = await insertReviewItem(getDb(), {
    addedByConversationId: conversationId,
    assignedToEveryone: false,
    assigneeUserIds: assignees.map((assignee) => assignee.id),
    body: title,
    conversationIds: [conversationId],
    dedupeKey: title,
    kind: "action",
    nowMs: Date.now(),
    request: {
      fields: [
        {
          id: "decision",
          kind: "choice",
          label: "Decision",
          options: [{ label: "Approve" }, { label: "Reject" }],
        },
      ],
      question: title,
    },
    title,
    visibility,
  });
  return item!.id;
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  const json = async (path: string) =>
    (await app.request(`http://localhost/api${path}`)).json();
  return {
    snooze: (body: unknown) =>
      app.request("http://localhost/api/automations", {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    unsnooze: (id: string) =>
      app.request(`http://localhost/api/automations/${id}`, {
        method: "DELETE",
      }),
    /** Every Inbox number: the badge, the waiting list and the Inbox list. */
    inbox: async () => ({
      count: ((await json("/review-items/count")) as { needsViewer: number })
        .needsViewer,
      inbox: (
        (await json("/review-items?for=viewer")) as {
          items: { title: string }[];
        }
      ).items.map((item) => item.title),
      waiting: (
        (await json("/review-items/waiting-conversations")) as {
          conversations: { conversationId: string }[];
        }
      ).conversations.map((row) => row.conversationId),
    }),
    versions: async () =>
      ((await json("/versions")) as { reviewItems: string }).reviewItems,
  };
}

const NEW_ITEM = { kind: "new_item" } as const;

function timer(firesAtMs: number) {
  return {
    kind: "event",
    namespace: "junior",
    resourceType: "timer",
    events: ["timer.fired"],
    firesAt: new Date(firesAtMs).toISOString(),
  } as const;
}

describe("snoozes", () => {
  let fixture: ConversationFixture;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    fixture = await createConversationFixture();
    await conversation(ROOT, "public");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeConversationFixture();
  });

  it("hides a snoozed row from every Inbox count for its creator only", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    await addItem(ROOT, [ana, bob], "Review acme entry");
    const asAna = api(fixture, ana);
    const asBob = api(fixture, bob);
    const awake = {
      count: 1,
      inbox: ["Review acme entry"],
      waiting: [ROOT],
    };
    expect(await asAna.inbox()).toEqual(awake);
    const versionBefore = await asAna.versions();

    const created = await asAna.snooze({
      action: "wake",
      subject: { conversationId: ROOT },
      triggers: [NEW_ITEM, timer(NOW_MS + 3 * 60 * 60 * 1000)],
    });
    expect(created.status).toBe(201);
    const snooze = (await created.json()) as { id: string };

    expect(await asAna.inbox()).toEqual({ count: 0, inbox: [], waiting: [] });
    expect(await asAna.versions()).not.toBe(versionBefore);
    // Each snooze has its own User.
    expect(await asBob.inbox()).toEqual(awake);

    // Only its creator can undo it.
    expect((await asBob.unsnooze(snooze.id)).status).toBe(404);
    expect((await asAna.unsnooze(snooze.id)).status).toBe(204);
    expect(await asAna.inbox()).toEqual(awake);
  });

  it("wakes on the first trigger: a due timer, or a new item", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    const snooze = (subject: Record<string, string>) =>
      asAna.snooze({
        action: "wake",
        subject,
        triggers: [NEW_ITEM, timer(NOW_MS + 60_000)],
      });

    expect((await snooze({ conversationId: ROOT })).status).toBe(201);
    expect((await asAna.inbox()).count).toBe(0);
    // The timer is due. The row is awake before the heartbeat settles it.
    vi.setSystemTime(NOW_MS + 60_000);
    expect((await asAna.inbox()).count).toBe(1);
    await runHeartbeat({
      conversationWorkQueue: fixture.queue,
      nowMs: Date.now(),
    });
    const [settled] = await getDb()
      .select({ status: juniorAutomations.status })
      .from(juniorAutomations)
      .where(eq(juniorAutomations.action, "wake"));
    expect(settled).toEqual({ status: "completed" });

    // A timer in the past cannot snooze.
    expect((await snooze({ conversationId: ROOT })).status).toBe(400);

    // A new item in the Conversation wakes the row, whoever it is for.
    vi.setSystemTime(NOW_MS);
    expect((await snooze({ conversationId: ROOT })).status).toBe(201);
    expect((await asAna.inbox()).count).toBe(0);
    const bob = await user("bob@example.com");
    await addItem(ROOT, [bob], "Review globex entry");
    expect(await asAna.inbox()).toEqual({
      count: 1,
      inbox: ["Review acme entry"],
      waiting: [ROOT],
    });
  });

  it("keeps one active snooze per row: a second one replaces the first", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    const snooze = (firesAtMs: number) =>
      asAna.snooze({
        action: "wake",
        subject: { conversationId: ROOT },
        triggers: [NEW_ITEM, timer(firesAtMs)],
      });

    expect((await snooze(NOW_MS + 60_000)).status).toBe(201);
    expect((await snooze(NOW_MS + 120_000)).status).toBe(201);
    const rows = await getDb()
      .select({
        nextRunAtMs: juniorAutomations.nextRunAtMs,
        status: juniorAutomations.status,
        statusReason: juniorAutomations.statusReason,
      })
      .from(juniorAutomations)
      .where(eq(juniorAutomations.action, "wake"))
      .orderBy(juniorAutomations.nextRunAtMs);
    expect(rows).toEqual([
      {
        nextRunAtMs: NOW_MS + 60_000,
        status: "completed",
        statusReason: "replaced",
      },
      { nextRunAtMs: NOW_MS + 120_000, status: "active", statusReason: null },
    ]);
    // The first timer is due, but the row stays asleep until the second.
    vi.setSystemTime(NOW_MS + 60_000);
    expect((await asAna.inbox()).count).toBe(0);

    // Overlapping snoozes replace in turn and both succeed.
    const overlapping = await Promise.all([
      snooze(NOW_MS + 180_000),
      snooze(NOW_MS + 240_000),
      snooze(NOW_MS + 300_000),
    ]);
    expect(overlapping.map((response) => response.status)).toEqual([
      201, 201, 201,
    ]);
    const active = await getDb()
      .select({ id: juniorAutomations.id })
      .from(juniorAutomations)
      .where(eq(juniorAutomations.status, "active"));
    expect(active).toHaveLength(1);
  });

  it("does not let a viewer snooze a row they cannot see", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    await conversation(PRIVATE_ROOT, "private");
    const itemId = await addItem(
      PRIVATE_ROOT,
      [ana],
      "Review private entry",
      "private",
    );
    const asBob = api(fixture, bob);

    for (const subject of [
      { conversationId: PRIVATE_ROOT },
      { conversationId: PRIVATE_ROOT, reviewItemId: itemId },
      { conversationId: "slack:CSNOOZE:missing" },
    ]) {
      const response = await asBob.snooze({
        action: "wake",
        subject,
        triggers: [NEW_ITEM],
      });
      expect(response.status).toBe(404);
    }
    expect(
      await getDb()
        .select()
        .from(juniorAutomations)
        .where(eq(juniorAutomations.action, "wake")),
    ).toEqual([]);
  });

  it("wakes a snooze, which has no Slack team, on a GitHub Event that the app publishes", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    try {
      await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
      const ana = await user("ana@example.com");
      await addItem(ROOT, [ana], "Review junior#7");
      const asAna = api(fixture, ana);
      const created = await asAna.snooze({
        action: "wake",
        subject: { conversationId: ROOT },
        triggers: [
          NEW_ITEM,
          {
            kind: "event",
            namespace: "github",
            resourceType: "pull_request",
            identifier: PR,
            events: ["pull_request.review.approved"],
            label: "Until reviewed",
          },
        ],
      });
      expect(created.status).toBe(201);
      expect((await asAna.inbox()).count).toBe(0);

      const publisher = createEventAppPublisher({
        conversationWork: () => ({
          queue: fixture.queue,
          state: createMemoryState(),
        }),
      });
      const event = (eventType: string) => ({
        eventKey: `github:snooze:${eventType}`,
        eventType,
        identifier: PR,
        namespace: "github",
        occurredAtMs: Date.now(),
        trustedSummary: "A pull request changed.",
      });
      // The webhook publishes only when something matches.
      await expect(
        publisher.hasMatch([event("pull_request.merged")]),
      ).resolves.toBe(false);
      await expect(
        publisher.hasMatch([event("pull_request.review.approved")]),
      ).resolves.toBe(true);

      await publisher.publish(event("pull_request.review.approved"));
      expect((await asAna.inbox()).count).toBe(1);
      // A wake runs no Turn.
      expect(fixture.queue.sentRecords()).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
