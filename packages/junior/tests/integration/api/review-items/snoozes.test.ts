import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { createIdentityDispatcher } from "@/chat/agent-dispatch/identity";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { getDb } from "@/chat/db";
import { juniorInboxSnoozes } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import {
  addItem,
  addNotice,
  api,
  conversation,
  NOW_MS,
  PRIVATE_ROOT,
  ROOT,
  user,
} from "../../../fixtures/snoozes";

const HOUR_MS = 60 * 60 * 1000;

/** Every stored snooze, oldest wake time first. */
async function storedSnoozes() {
  return getDb()
    .select({
      reason: juniorInboxSnoozes.reason,
      status: juniorInboxSnoozes.status,
      wakeAtMs: juniorInboxSnoozes.wakeAtMs,
    })
    .from(juniorInboxSnoozes)
    .orderBy(juniorInboxSnoozes.wakeAtMs, juniorInboxSnoozes.createdAt);
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
    expect(await asAna.snoozed()).toEqual([]);
    const versionBefore = await asAna.versions();

    const created = await asAna.snooze(
      { conversationId: ROOT },
      NOW_MS + 3 * HOUR_MS,
    );
    expect(created.status).toBe(201);

    expect(await asAna.inbox()).toEqual({ count: 0, inbox: [], waiting: [] });
    expect(await asAna.snoozed()).toEqual(["Review acme entry"]);
    expect(await asAna.versions()).not.toBe(versionBefore);
    // Each snooze has its own User.
    expect(await asBob.inbox()).toEqual(awake);

    // Only its creator can undo it.
    expect((await asBob.unsnooze({ conversationId: ROOT })).status).toBe(204);
    expect((await asAna.inbox()).count).toBe(0);
    expect((await asAna.unsnooze({ conversationId: ROOT })).status).toBe(204);
    expect(await asAna.inbox()).toEqual(awake);
    expect(await storedSnoozes()).toEqual([
      {
        reason: "unsnoozed",
        status: "cancelled",
        wakeAtMs: NOW_MS + 3 * HOUR_MS,
      },
    ]);
  });

  it("wakes at its time or on a new item, whichever comes first", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);

    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + 60_000)).status,
    ).toBe(201);
    expect((await asAna.inbox()).count).toBe(0);
    // The time has come. The row is awake before the heartbeat settles it.
    vi.setSystemTime(NOW_MS + 60_000);
    expect((await asAna.inbox()).count).toBe(1);
    await runHeartbeat({
      conversationWorkQueue: fixture.queue,
      dispatchForIdentity: createIdentityDispatcher({
        conversationWorkQueue: () => fixture.queue,
      }),
      events: createEventAppPublisher({
        conversationWork: () => ({ queue: fixture.queue }),
      }),
      nowMs: Date.now(),
    });
    expect(await storedSnoozes()).toEqual([
      { reason: "time", status: "woken", wakeAtMs: NOW_MS + 60_000 },
    ]);

    // A time in the past cannot snooze.
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + 60_000)).status,
    ).toBe(400);

    // A new item in the Conversation wakes the row, whoever it is for.
    vi.setSystemTime(NOW_MS);
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + HOUR_MS)).status,
    ).toBe(201);
    expect((await asAna.inbox()).count).toBe(0);
    const bob = await user("bob@example.com");
    await addItem(ROOT, [bob], "Review globex entry");
    expect(await asAna.inbox()).toEqual({
      count: 1,
      inbox: ["Review acme entry"],
      waiting: [ROOT],
    });
    expect((await storedSnoozes())[1]).toEqual({
      reason: "new_item",
      status: "woken",
      wakeAtMs: NOW_MS + HOUR_MS,
    });
  });

  it("changes the versions token when a snooze is due, before the heartbeat", async () => {
    const ana = await user("ana@example.com");
    // A notice waits on nobody, so no count moves when it wakes.
    await addNotice(ROOT, [ana], "Acme entry merged");
    const asAna = api(fixture, ana);
    const created = await asAna.snooze(
      { conversationId: ROOT },
      NOW_MS + 60_000,
    );
    expect(created.status).toBe(201);
    const asleep = await asAna.versions();
    vi.setSystemTime(NOW_MS + 59_000);
    expect(await asAna.versions()).toBe(asleep);
    vi.setSystemTime(NOW_MS + 60_000);
    expect(await asAna.versions()).not.toBe(asleep);
  });

  it("keeps one active snooze per row: a second one replaces the first", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    const snooze = (wakeAtMs: number) =>
      asAna.snooze({ conversationId: ROOT }, wakeAtMs);

    expect((await snooze(NOW_MS + 60_000)).status).toBe(201);
    expect((await snooze(NOW_MS + 120_000)).status).toBe(201);
    expect(await storedSnoozes()).toEqual([
      { reason: "replaced", status: "cancelled", wakeAtMs: NOW_MS + 60_000 },
      { reason: null, status: "active", wakeAtMs: NOW_MS + 120_000 },
    ]);
    // The first time has come, but the row stays asleep until the second.
    vi.setSystemTime(NOW_MS + 60_000);
    expect((await asAna.inbox()).count).toBe(0);

    // Overlapping snoozes replace in turn and all succeed.
    const overlapping = await Promise.all([
      snooze(NOW_MS + 180_000),
      snooze(NOW_MS + 240_000),
      snooze(NOW_MS + 300_000),
    ]);
    expect(overlapping.map((response) => response.status)).toEqual([
      201, 201, 201,
    ]);
    const active = (await storedSnoozes()).filter(
      (row) => row.status === "active",
    );
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
      const response = await asBob.snooze(subject, NOW_MS + HOUR_MS);
      expect(response.status).toBe(404);
    }
    expect(await storedSnoozes()).toEqual([]);
  });
});
