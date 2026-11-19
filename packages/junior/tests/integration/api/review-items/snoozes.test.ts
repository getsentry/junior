import type { Event } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { createIdentityDispatcher } from "@/chat/agent-dispatch/identity";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { getDb } from "@/chat/db";
import { getReviewItem } from "@/chat/review-items/store";
import { juniorInboxSnoozes, juniorInboxSnoozeTriggers } from "@/db/schema";
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

/** Every stored snooze state, oldest first. */
async function storedStates() {
  const rows = await getDb()
    .select({ state: juniorInboxSnoozes.state })
    .from(juniorInboxSnoozes)
    .orderBy(juniorInboxSnoozes.createdAt, juniorInboxSnoozes.id);
  return rows.map((row) => row.state);
}

/** A GitHub-style Event about one pull request. */
function pullRequestEvent(eventType: string): Event {
  return {
    eventKey: `${eventType}:1`,
    eventType,
    identifier: "getsentry/junior#1",
    namespace: "github",
    occurredAtMs: Date.now(),
    trustedSummary: "Pull request changed.",
  };
}

/** Add a trigger on a pull request Event to every stored snooze. */
async function addPullRequestTrigger(
  outcome: "resolve" | "wake",
  eventType: string,
) {
  const snoozes = await getDb()
    .select({ id: juniorInboxSnoozes.id })
    .from(juniorInboxSnoozes)
    .where(eq(juniorInboxSnoozes.state, "snoozed"));
  await getDb()
    .insert(juniorInboxSnoozeTriggers)
    .values(
      snoozes.map((snooze) => ({
        eventType,
        identifier: "getsentry/junior#1",
        namespace: "github",
        outcome,
        snoozeId: snooze.id,
      })),
    );
}

describe("snoozes", () => {
  let fixture: ConversationFixture;
  const publisher = () =>
    createEventAppPublisher({
      conversationWork: () => ({ queue: fixture.queue }),
    });
  const heartbeat = () =>
    runHeartbeat({
      conversationWorkQueue: fixture.queue,
      dispatchForIdentity: createIdentityDispatcher({
        conversationWorkQueue: () => fixture.queue,
      }),
      events: publisher(),
      nowMs: Date.now(),
    });

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

  it("hides a snoozed row from every Inbox count for its person only", async () => {
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const acme = await addItem(ROOT, [ana, bob], "Review acme entry");
    vi.setSystemTime(NOW_MS + 1);
    await addItem(ROOT, [ana, bob], "Review globex entry");
    const asAna = api(fixture, ana);
    const asBob = api(fixture, bob);
    const awake = {
      count: 2,
      inbox: ["Review acme entry", "Review globex entry"],
      waiting: [ROOT],
    };
    expect(await asAna.inbox()).toEqual(awake);
    const versionBefore = await asAna.versions();

    // A row snooze is one snooze per open item in it.
    const created = await asAna.snooze(
      { conversationId: ROOT },
      NOW_MS + 3 * HOUR_MS,
    );
    expect(created.status).toBe(201);
    expect(await storedStates()).toEqual(["snoozed", "snoozed"]);
    expect(await asAna.inbox()).toEqual({ count: 0, inbox: [], waiting: [] });
    expect((await asAna.snoozed()).sort()).toEqual(awake.inbox);
    expect(await asAna.versions()).not.toBe(versionBefore);
    // Bob's Inbox does not change, and his Wake does not touch Ana's snooze.
    expect(await asBob.inbox()).toEqual(awake);
    expect((await asBob.unsnooze({ conversationId: ROOT })).status).toBe(204);
    expect((await asAna.inbox()).count).toBe(0);

    // Bob's own snooze of one item stays when Ana wakes her row.
    expect(
      (
        await asBob.snooze(
          { conversationId: ROOT, reviewItemId: acme },
          NOW_MS + HOUR_MS,
        )
      ).status,
    ).toBe(201);
    expect((await asAna.unsnooze({ conversationId: ROOT })).status).toBe(204);
    expect(await asAna.inbox()).toEqual(awake);
    expect(await asBob.inbox()).toEqual({
      count: 1,
      inbox: ["Review globex entry"],
      waiting: [ROOT],
    });
  });

  it("wakes when its timer fires", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + 60_000)).status,
    ).toBe(201);

    vi.setSystemTime(NOW_MS + 59_000);
    await heartbeat();
    expect((await asAna.inbox()).count).toBe(0);
    const asleep = await asAna.versions();

    // The timer.fired Event wakes it, and the versions token moves.
    vi.setSystemTime(NOW_MS + 60_000);
    await heartbeat();
    expect((await asAna.inbox()).count).toBe(1);
    expect(await asAna.versions()).not.toBe(asleep);
    expect(await storedStates()).toEqual(["woken"]);

    // A time in the past cannot snooze.
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + 60_000)).status,
    ).toBe(400);
  });

  it("shows a new item in a snoozed row alone, and the rest stay snoozed", async () => {
    const ana = await user("ana@example.com");
    // A notice waits on nobody, so the Inbox list would show it awake.
    await addNotice(ROOT, [ana], "Acme entry merged");
    const asAna = api(fixture, ana);
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + HOUR_MS)).status,
    ).toBe(201);
    expect((await asAna.inbox()).inbox).toEqual([]);

    await addItem(ROOT, [ana], "Review globex entry");
    expect((await asAna.inbox()).inbox).toEqual(["Review globex entry"]);
    expect(await storedStates()).toEqual(["snoozed"]);
  });

  it("wakes on a published Event that a trigger names", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    await asAna.snooze({ conversationId: ROOT }, NOW_MS + HOUR_MS);
    await addPullRequestTrigger("wake", "pull_request.review_requested");

    // Another Event on the resource does not fire the trigger.
    await publisher().publish(pullRequestEvent("pull_request.merged"));
    expect((await asAna.inbox()).count).toBe(0);
    const event = pullRequestEvent("pull_request.review_requested");
    expect(await publisher().hasMatch([event])).toBe(true);
    await publisher().publish(event);
    expect((await asAna.inbox()).count).toBe(1);
    expect(await publisher().hasMatch([event])).toBe(false);
  });

  it("lets the first trigger win when resolve races wake", async () => {
    const ana = await user("ana@example.com");
    const asAna = api(fixture, ana);
    const merged = pullRequestEvent("pull_request.merged");

    // Resolve first: the item is dismissed, and the timer does nothing.
    const first = await addItem(ROOT, [ana], "Review acme entry");
    await asAna.snooze({ conversationId: ROOT }, NOW_MS + 60_000);
    await addPullRequestTrigger("resolve", "pull_request.merged");
    await publisher().publish(merged);
    expect((await getReviewItem(getDb(), first))?.status).toBe("dismissed");
    vi.setSystemTime(NOW_MS + 60_000);
    await heartbeat();
    expect(await storedStates()).toEqual(["cancelled"]);
    expect(await asAna.inbox()).toEqual({ count: 0, inbox: [], waiting: [] });

    // Wake first: the item comes back, and a later resolve does nothing.
    const second = await addItem(ROOT, [ana], "Review globex entry");
    await asAna.snooze({ conversationId: ROOT }, NOW_MS + 120_000);
    await addPullRequestTrigger("resolve", "pull_request.merged");
    vi.setSystemTime(NOW_MS + 120_000);
    await heartbeat();
    await publisher().publish(merged);
    expect((await getReviewItem(getDb(), second))?.status).toBe("open");
    expect(await storedStates()).toEqual(["cancelled", "woken"]);
    expect((await asAna.inbox()).inbox).toEqual(["Review globex entry"]);
  });

  it("keeps one snooze per item: a second one replaces the first", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    const snooze = (wakeAtMs: number) =>
      asAna.snooze({ conversationId: ROOT }, wakeAtMs);

    expect((await snooze(NOW_MS + 60_000)).status).toBe(201);
    vi.setSystemTime(NOW_MS + 1);
    expect((await snooze(NOW_MS + 120_000)).status).toBe(201);
    expect(await storedStates()).toEqual(["cancelled", "snoozed"]);
    // The first timer fires, but only the second snooze is left.
    vi.setSystemTime(NOW_MS + 60_000);
    await heartbeat();
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
    expect(
      (await storedStates()).filter((state) => state === "snoozed"),
    ).toHaveLength(1);

    // An item linked to two roots is in both rows. Snoozes from each row
    // at once still replace in turn.
    const other = "slack:CSNOOZE:1.000002";
    await conversation(other, "public");
    await addItem(other, [ana], "Review shared entry", "public", [ROOT]);
    const snoozeIn = (conversationId: string, wakeAtMs: number) =>
      asAna.snooze({ conversationId }, wakeAtMs);
    const fromBothRows = await Promise.all([
      snoozeIn(ROOT, NOW_MS + 360_000),
      snoozeIn(other, NOW_MS + 420_000),
      snoozeIn(ROOT, NOW_MS + 480_000),
      snoozeIn(other, NOW_MS + 540_000),
    ]);
    expect(fromBothRows.map((response) => response.status)).toEqual([
      201, 201, 201, 201,
    ]);
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
    expect(await storedStates()).toEqual([]);
  });
});
