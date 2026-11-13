import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { getDb } from "@/chat/db";
import { juniorAutomations } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  addItem,
  api,
  conversation,
  NEW_ITEM,
  NOW_MS,
  PRIVATE_ROOT,
  PULL_REQUEST_REVIEW_WAKES,
  ROOT,
  timer,
  user,
  wakeOnPullRequestReview,
} from "../../../fixtures/snoozes";

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
    try {
      expect(await wakeOnPullRequestReview(fixture)).toEqual(
        PULL_REQUEST_REVIEW_WAKES,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
