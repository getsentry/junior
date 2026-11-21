import type { Event } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_VERSION_HEADER } from "@/api/schema";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { createIdentityDispatcher } from "@/chat/agent-dispatch/identity";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { getDb } from "@/chat/db";
import { getStateAdapter } from "@/chat/state/adapter";
import {
  getInboxItem,
  waitingConversationIdsQuery,
} from "@/chat/inbox-items/store";
import { juniorInboxSnoozes, juniorInboxItemAssignees } from "@/db/schema";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { useGitHubEvents } from "../../../fixtures/event-automations";
import {
  addItem,
  addNotice,
  addPullRequestItem,
  api,
  conversation,
  linkGitHub,
  NOTHING_SNOOZED,
  NOW_MS,
  MISSING_PULL_REQUEST_URL,
  OTHER_PULL_REQUEST,
  PRIVATE_ROOT,
  PULL_REQUEST,
  ROOT,
  useGitHubRepository,
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

/** The roots that the Conversations feed's Needs you section pins. */
async function feedWaitingIds(userId: string) {
  const rows = await waitingConversationIdsQuery(getDb(), userId);
  return [...new Set(rows.map((row) => row.conversationId))];
}

/** A GitHub Event about `PULL_REQUEST`, or another pull request. */
function pullRequestEvent(
  eventType: string,
  identifier = PULL_REQUEST.identifier,
): Event {
  return {
    eventKey: `${eventType}:${identifier}`,
    eventType,
    identifier,
    namespace: "github",
    occurredAtMs: Date.now(),
    trustedSummary: "Pull request changed.",
  };
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
    vi.unstubAllEnvs();
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
    expect(await asAna.snoozed()).toEqual(NOTHING_SNOOZED);
    expect(await feedWaitingIds(ana.id)).toEqual([ROOT]);
    const versionBefore = await asAna.versions();
    // The versions poll reads the count again with the token of the copy
    // it holds. An unchanged count comes back empty.
    const countRead = await asAna.request("/inbox-items/count");
    expect(countRead.headers.get("cache-control")).toBe("private, no-store");
    const readCountAgain = () =>
      asAna.request("/inbox-items/count", {
        [CONTENT_VERSION_HEADER]: countRead.headers.get(
          CONTENT_VERSION_HEADER,
        )!,
      });
    const unchanged = await readCountAgain();
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    // So does the list.
    const listRead = await asAna.request("/inbox-items?for=viewer");
    const readListAgain = () =>
      asAna.request("/inbox-items?for=viewer", {
        [CONTENT_VERSION_HEADER]: listRead.headers.get(CONTENT_VERSION_HEADER)!,
      });
    expect((await readListAgain()).status).toBe(304);

    // A row snooze is one snooze per open item in it.
    const created = await asAna.snooze(
      { conversationId: ROOT },
      NOW_MS + 3 * HOUR_MS,
    );
    expect(created.status).toBe(201);
    expect(await storedStates()).toEqual(["snoozed", "snoozed"]);
    expect(await asAna.inbox()).toEqual({ count: 0, inbox: [], waiting: [] });
    expect((await readCountAgain()).status).toBe(200);
    expect((await readListAgain()).status).toBe(200);
    expect(await feedWaitingIds(ana.id)).toEqual([]);
    const snoozed = await asAna.snoozed();
    expect(snoozed.count).toBe(2);
    expect([...snoozed.items].sort()).toEqual(awake.inbox);
    expect(await asAna.versions()).not.toBe(versionBefore);
    // Bob's Inbox does not change, and his Wake does not touch Ana's snooze.
    expect(await asBob.inbox()).toEqual(awake);
    expect(await asBob.snoozed()).toEqual(NOTHING_SNOOZED);
    expect((await asBob.unsnooze({ conversationId: ROOT })).status).toBe(204);
    expect((await asAna.inbox()).count).toBe(0);

    // Bob's own snooze of one item stays when Ana wakes her row.
    expect(
      (
        await asBob.snooze(
          { conversationId: ROOT, inboxItemId: acme },
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

  it("counts each item that one snooze on their root hides", async () => {
    const ana = await user("ana@example.com");
    const other = "slack:CSNOOZE:1.000002";
    await conversation(other, "public");
    await addItem(ROOT, [ana], "Review acme entry");
    // Another Conversation adds an item linked to the root: its own row.
    await addItem(ROOT, [ana], "Review beta entry", "public", other);
    const asAna = api(fixture, ana);
    await asAna.snooze({ conversationId: ROOT }, NOW_MS + 3 * HOUR_MS);

    const snoozed = await asAna.snoozed();
    expect(snoozed.count).toBe(2);
    expect([...snoozed.items].sort()).toEqual([
      "Review acme entry",
      "Review beta entry",
    ]);
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

  it("wakes on the Event of its subject that the viewer picked", async () => {
    await useGitHubEvents();
    const ana = await user("ana@example.com");
    await addPullRequestItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    // The item names its pull request, so the menu can offer its Events.
    const [subject] = (await asAna.subjects()) as {
      resource: { events: string[] };
    }[];
    expect(subject?.resource).toMatchObject({
      namespace: "github",
      phrases: { "pull_request.checks.passed": "passes its checks" },
      resourceType: "pull_request",
    });
    expect(subject?.resource.events).toContain("pull_request.checks.passed");

    const snoozed = await asAna.snoozeOn({ conversationId: ROOT }, [
      { eventType: "pull_request.checks.passed", outcome: "wake" },
    ]);
    expect(snoozed.status).toBe(201);
    expect((await asAna.inbox()).count).toBe(0);

    // Another Event on the resource does not fire the trigger.
    await publisher().publish(pullRequestEvent("pull_request.merged"));
    expect((await asAna.inbox()).count).toBe(0);
    const event = pullRequestEvent("pull_request.checks.passed");
    expect(await publisher().hasMatch([event])).toBe(true);
    await publisher().publish(event);
    expect((await asAna.inbox()).count).toBe(1);
    expect(await storedStates()).toEqual(["woken"]);
    expect(await publisher().hasMatch([event])).toBe(false);
  });

  it("takes every Event of its subject at once", async () => {
    await useGitHubEvents();
    const ana = await user("ana@example.com");
    await addPullRequestItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    const [subject] = (await asAna.subjects()) as {
      resource: { events: string[] };
    }[];
    const events = subject?.resource.events ?? [];
    expect(events.length).toBeGreaterThan(10);

    const snoozed = await asAna.snoozeOn(
      { conversationId: ROOT },
      events.map((eventType) => ({ eventType, outcome: "wake" as const })),
    );
    expect(snoozed.status).toBe(201);
    expect((await asAna.inbox()).count).toBe(0);
  });

  it("wakes on an Event of another pull request that the viewer names", async () => {
    await useGitHubEvents();
    useGitHubRepository(["ana-gh"]);
    const ana = await linkGitHub(await user("ana@example.com"), "ana-gh");
    await addPullRequestItem(ROOT, [ana], "Review acme entry");
    // An item without a subject can wait on a named page too.
    await addItem(ROOT, [ana], "Review globex entry");
    const asAna = api(fixture, ana);
    // The menu reads the Events of the pull request that Ana pastes, with
    // how the GitHub plugin says each one reads.
    const resource = await asAna.resource(OTHER_PULL_REQUEST.url);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({
      namespace: "github",
      phrases: { "pull_request.merged": "is merged" },
      resourceType: "pull_request",
    });

    const snoozed = await asAna.snoozeOn({ conversationId: ROOT }, [
      {
        eventType: "pull_request.merged",
        outcome: "wake",
        resourceUrl: OTHER_PULL_REQUEST.url,
      },
    ]);
    expect(snoozed.status).toBe(201);
    // The same Event on the item's own pull request does not wake it.
    await publisher().publish(pullRequestEvent("pull_request.merged"));
    expect((await asAna.inbox()).count).toBe(0);
    await publisher().publish(
      pullRequestEvent("pull_request.merged", OTHER_PULL_REQUEST.identifier),
    );
    expect((await asAna.inbox()).count).toBe(2);
    expect(await storedStates()).toEqual(["woken", "woken"]);
  });

  it("rejects a page that the viewer cannot see, that is missing, or that has no Events", async () => {
    await useGitHubEvents();
    useGitHubRepository(["ana-gh"]);
    const ana = await linkGitHub(await user("ana@example.com"), "ana-gh");
    const bob = await linkGitHub(await user("bob@example.com"), "bob-gh");
    const carol = await user("carol@example.com");
    await addPullRequestItem(ROOT, [ana, bob, carol], "Review acme entry");
    const merged = (resourceUrl: string) => [
      {
        eventType: "pull_request.merged",
        outcome: "wake" as const,
        resourceUrl,
      },
    ];
    // Bob's GitHub account cannot see the repository, and Carol has none.
    for (const viewer of [bob, carol]) {
      const asViewer = api(fixture, viewer);
      expect((await asViewer.resource(OTHER_PULL_REQUEST.url)).status).toBe(
        404,
      );
      expect(
        (
          await asViewer.snoozeOn(
            { conversationId: ROOT },
            merged(OTHER_PULL_REQUEST.url),
          )
        ).status,
      ).toBe(400);
    }
    // A page with no Event resource, such as a profile.
    const asBob = api(fixture, bob);
    expect((await asBob.resource("https://github.com/getsentry")).status).toBe(
      404,
    );
    // Ana can see the repository, but no Event comes from a missing page.
    const asAna = api(fixture, ana);
    expect((await asAna.resource(MISSING_PULL_REQUEST_URL)).status).toBe(404);
    expect(
      (
        await asAna.snoozeOn(
          { conversationId: ROOT },
          merged(MISSING_PULL_REQUEST_URL),
        )
      ).status,
    ).toBe(400);
    expect(await storedStates()).toEqual([]);
    expect((await asBob.inbox()).count).toBe(1);
    // Ana's account can see the repository, so the same snooze holds.
    expect(
      (
        await api(fixture, ana).snoozeOn(
          { conversationId: ROOT },
          merged(OTHER_PULL_REQUEST.url),
        )
      ).status,
    ).toBe(201);
  });

  it("lets the first trigger win when resolve races wake", async () => {
    await useGitHubEvents();
    const ana = await user("ana@example.com");
    const asAna = api(fixture, ana);
    const merged = pullRequestEvent("pull_request.merged");
    const resolveOnMerge = (wakeAtMs: number) =>
      asAna.snoozeOn(
        { conversationId: ROOT },
        [{ eventType: "pull_request.merged", outcome: "resolve" }],
        wakeAtMs,
      );

    // Resolve first: the item is dismissed, and the timer does nothing.
    const first = await addPullRequestItem(ROOT, [ana], "Review acme entry");
    expect((await resolveOnMerge(NOW_MS + 60_000)).status).toBe(201);
    await publisher().publish(merged);
    expect((await getInboxItem(getDb(), first))?.status).toBe("dismissed");
    vi.setSystemTime(NOW_MS + 60_000);
    await heartbeat();
    expect(await storedStates()).toEqual(["cancelled"]);
    expect(await asAna.inbox()).toEqual({ count: 0, inbox: [], waiting: [] });

    // Wake first: the item comes back, and a later resolve does nothing.
    const second = await addPullRequestItem(ROOT, [ana], "Review globex entry");
    expect((await resolveOnMerge(NOW_MS + 120_000)).status).toBe(201);
    vi.setSystemTime(NOW_MS + 120_000);
    await heartbeat();
    await publisher().publish(merged);
    expect((await getInboxItem(getDb(), second))?.status).toBe("open");
    expect(await storedStates()).toEqual(["cancelled", "woken"]);
    expect((await asAna.inbox()).inbox).toEqual(["Review globex entry"]);
  });

  it("takes only Events that each item's subject has, from a person who can act", async () => {
    await useGitHubEvents();
    const ana = await user("ana@example.com");
    const bob = await user("bob@example.com");
    const own = await addPullRequestItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    const merged = {
      eventType: "pull_request.merged",
      outcome: "wake" as const,
    };

    // Neither a time nor an Event.
    expect(
      (await asAna.snoozeOn({ conversationId: ROOT, inboxItemId: own }, []))
        .status,
    ).toBe(400);
    // An Event that the pull request has no type for.
    expect(
      (
        await asAna.snoozeOn({ conversationId: ROOT, inboxItemId: own }, [
          { eventType: "issue.closed", outcome: "wake" },
        ])
      ).status,
    ).toBe(400);
    // Ana can see Bob's item, but only Bob can dismiss it.
    const bobs = await addPullRequestItem(ROOT, [bob], "Review initech entry");
    const resolve = {
      eventType: "pull_request.merged",
      outcome: "resolve" as const,
    };
    const subject = { conversationId: ROOT, inboxItemId: bobs };
    expect((await asAna.snoozeOn(subject, [resolve])).status).toBe(400);
    expect(await storedStates()).toEqual([]);
    // A row snoozes only the items that take the Event: not an item that
    // names no resource, nor one that Ana cannot dismiss.
    await addItem(ROOT, [ana], "Review globex entry");
    const snoozed = await asAna.snoozeOn({ conversationId: ROOT }, [resolve]);
    expect(snoozed.status).toBe(201);
    expect(await snoozed.json()).toEqual({ inboxItemIds: [own] });
    expect((await asAna.inbox()).inbox).toContain("Review globex entry");
    expect((await asAna.snoozeOn(subject, [merged])).status).toBe(201);
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
    await addItem(other, [ana], "Review shared entry", "public", other, [ROOT]);
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

  it("shows nothing in Snoozed once the viewer loses access to the row", async () => {
    const ana = await user("ana@example.com");
    await conversation(PRIVATE_ROOT, "private");
    const itemId = await addItem(
      PRIVATE_ROOT,
      [ana],
      "Review private entry",
      "private",
    );
    const asAna = api(fixture, ana);
    const subject = { conversationId: PRIVATE_ROOT, inboxItemId: itemId };
    expect((await asAna.snooze(subject, NOW_MS + HOUR_MS)).status).toBe(201);
    expect(await asAna.snoozed()).toEqual({
      count: 1,
      items: ["Review private entry"],
    });

    // A private item is for its assignees only.
    await getDb()
      .delete(juniorInboxItemAssignees)
      .where(eq(juniorInboxItemAssignees.itemId, itemId));
    expect(await asAna.snoozed()).toEqual(NOTHING_SNOOZED);
  });

  it("keeps the earlier snooze when the new timer cannot be added", async () => {
    const ana = await user("ana@example.com");
    await addItem(ROOT, [ana], "Review acme entry");
    const asAna = api(fixture, ana);
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + 60_000)).status,
    ).toBe(201);

    vi.spyOn(getStateAdapter(), "acquireLock").mockRejectedValueOnce(
      new Error("state store is down"),
    );
    expect(
      (await asAna.snooze({ conversationId: ROOT }, NOW_MS + 120_000)).status,
    ).toBe(500);
    expect(await storedStates()).toEqual(["snoozed"]);
    expect((await asAna.inbox()).count).toBe(0);

    // The earlier timer still wakes it.
    vi.setSystemTime(NOW_MS + 60_000);
    await heartbeat();
    expect((await asAna.inbox()).count).toBe(1);
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
      { conversationId: PRIVATE_ROOT, inboxItemId: itemId },
      { conversationId: "slack:CSNOOZE:missing" },
    ]) {
      const response = await asBob.snooze(subject, NOW_MS + HOUR_MS);
      expect(response.status).toBe(404);
    }
    expect(await storedStates()).toEqual([]);
  });
});
