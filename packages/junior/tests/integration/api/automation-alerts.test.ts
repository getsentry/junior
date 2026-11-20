import { githubPlugin } from "@sentry/junior-github";
import type { User } from "@sentry/junior-plugin-api";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { runHeartbeat } from "@/chat/agent-dispatch/heartbeat";
import { createIdentityDispatcher } from "@/chat/agent-dispatch/identity";
import { recordAutomationExecution } from "@/chat/automations/execution-stats";
import { getDb } from "@/chat/db";
import { juniorReviewItems } from "@/db/schema";
import {
  createEventAutomation,
  deleteEventAutomation,
} from "@/chat/event-automations/store";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import type { ScheduledAutomation } from "@/chat/scheduled-automations/types";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../fixtures/conversation";
import {
  addItem,
  api,
  conversation,
  NOTHING_SNOOZED,
  NOW_MS,
  PRIVATE_ROOT,
  ROOT,
  user,
} from "../../fixtures/snoozes";

const HOUR_MS = 60 * 60 * 1000;
const PUBLIC_CHANNEL = {
  platform: "slack" as const,
  teamId: "T123",
  channelId: "CSNOOZE",
};

type Alert = {
  body: string;
  id: string;
  kind: string;
  owner: { id: string; kind: string };
  status: string;
  title: string;
  visibility: string;
};

/** A daily Automation that `creator` made, posting to `destination`. */
function scheduled(
  creator: User,
  overrides: Partial<ScheduledAutomation> = {},
): ScheduledAutomation {
  return {
    id: "sched_digest",
    conversationAccess: { audience: "channel", visibility: "public" },
    createdAtMs: NOW_MS,
    createdBy: { slackUserId: `U-${creator.email}` },
    creatorIdentityId: creator.identities.find(
      (identity) => identity.provider === "slack",
    )!.id,
    credentialMode: "creator",
    destination: PUBLIC_CHANNEL,
    nextRunAtMs: NOW_MS + HOUR_MS,
    outcomes: [],
    schedule: {
      description: "Every day",
      kind: "recurring",
      recurrence: {
        frequency: "daily",
        interval: 1,
        startDate: "2026-10-01",
        time: { hour: 9, minute: 0 },
      },
      timezone: "UTC",
    },
    status: "active",
    task: { kind: "instruction", instruction: "Post the daily digest." },
    title: "Daily digest",
    updatedAtMs: NOW_MS,
    ...overrides,
  };
}

/** The dashboard API as one viewer, with the Automation alert reads. */
function alertApi(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return {
    ...api(fixture, viewer),
    /** The open alerts of an Automation. */
    alerts: async (automationId: string) => {
      const response = await app.request(
        "http://localhost/api/review-items?owner=automation",
      );
      const { items } = (await response.json()) as { items: Alert[] };
      return items.filter(
        (item) => item.owner.id === automationId && item.status === "open",
      );
    },
    /** The alerts in the viewer's To do, as the Automations page lists them. */
    todoAlerts: async () => {
      const response = await app.request(
        "http://localhost/api/review-items?for=viewer&owner=automation&sort=waiting",
      );
      const { items } = (await response.json()) as { items: Alert[] };
      return items.map((item) => item.title);
    },
    item: async (id: string) => {
      const response = await app.request(
        `http://localhost/api/review-items/${id}`,
      );
      return { body: await response.json(), status: response.status };
    },
    dismiss: (id: string) =>
      app.request(`http://localhost/api/review-items/${id}/actions`, {
        body: JSON.stringify({ action: "dismiss" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
  };
}

describe("Automation alerts", () => {
  let fixture: ConversationFixture;
  const heartbeat = () =>
    runHeartbeat({
      conversationWorkQueue: fixture.queue,
      dispatchForIdentity: createIdentityDispatcher({
        conversationWorkQueue: () => fixture.queue,
      }),
      events: createEventAppPublisher({
        conversationWork: () => ({ queue: fixture.queue }),
      }),
      nowMs: Date.now(),
    });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    fixture = await createConversationFixture();
    // Record the public and private channels as Destinations.
    await conversation(ROOT, "public");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    await closeConversationFixture();
  });

  it("puts an Automation that needs attention in its creator's Inbox as an item", async () => {
    const creator = await user("creator@example.com");
    const reader = await user("reader@example.com");
    const asCreator = alertApi(fixture, creator);
    const task = scheduled(creator, {
      status: "blocked",
      statusReason: "GitHub access expired.",
    });
    await saveScheduledAutomation(getDb(), task);
    // An item that a Conversation owns is not an Automation alert.
    await addItem(ROOT, [creator], "Approve the digest rollout");

    const [blocked] = await asCreator.alerts(task.id);
    expect(blocked).toMatchObject({
      body: "Blocked: GitHub access expired. Fix the problem, then resume it.",
      kind: "action",
      owner: { id: task.id, kind: "automation" },
      // A public channel Destination makes the alert public.
      visibility: "public",
    });
    expect((await asCreator.inbox()).count).toBe(2);
    expect(await asCreator.todoAlerts()).toEqual(["Daily digest"]);
    // A reader of the channel can see the alert. It waits on the creator only.
    const asReader = alertApi(fixture, reader);
    expect((await asReader.item(blocked!.id)).status).toBe(200);
    expect((await asReader.inbox()).count).toBe(0);

    // The creator snoozes it like any other item.
    const snooze = await asCreator.snooze(
      { reviewItemId: blocked!.id },
      NOW_MS + HOUR_MS,
    );
    expect(snooze.status).toBe(201);
    expect((await asCreator.inbox()).count).toBe(1);
    expect(await asCreator.todoAlerts()).toEqual([]);
    expect(await asCreator.snoozed()).toEqual({
      count: 1,
      items: ["Daily digest"],
    });

    // A resume fixes it, so the alert closes and Snoozed empties.
    await saveScheduledAutomation(getDb(), {
      ...task,
      status: "active",
      statusReason: undefined,
    });
    expect((await asCreator.item(blocked!.id)).body).toMatchObject({
      closeReason: "The Automation no longer needs attention.",
      status: "dismissed",
    });
    expect(await asCreator.snoozed()).toEqual(NOTHING_SNOOZED);

    // A failed run is a new alert.
    await recordAutomationExecution(task.id, {
      errorMessage: "Slack rejected the message.",
      executionId: "run-1",
      nowMs: NOW_MS,
      status: "failed",
    });
    const [failed] = await asCreator.alerts(task.id);
    expect(failed).toMatchObject({
      body: "Last run failed: Slack rejected the message.",
    });
    expect(failed!.id).not.toBe(blocked!.id);

    // A dismissed alert stays closed while that run is the last one.
    expect((await asCreator.dismiss(failed!.id)).status).toBe(200);
    await saveScheduledAutomation(getDb(), { ...task, status: "paused" });
    await saveScheduledAutomation(getDb(), { ...task, status: "active" });
    expect(await asCreator.alerts(task.id)).toEqual([]);
    expect(await asCreator.todoAlerts()).toEqual([]);

    // A newer failure opens a fresh alert.
    await recordAutomationExecution(task.id, {
      executionId: "run-2",
      nowMs: NOW_MS + 1,
      status: "failed",
    });
    const [again] = await asCreator.alerts(task.id);
    expect(again).toMatchObject({ body: "Last run failed." });
    expect(again!.id).not.toBe(failed!.id);

    // A run that completes closes it.
    await recordAutomationExecution(task.id, {
      executionId: "run-3",
      nowMs: NOW_MS + 2,
      status: "completed",
    });
    expect(await asCreator.alerts(task.id)).toEqual([]);
    expect(await asCreator.todoAlerts()).toEqual([]);
  });

  it("keeps the alert of a private Destination from other people", async () => {
    await conversation(PRIVATE_ROOT, "private");
    const creator = await user("creator@example.com");
    const reader = await user("reader@example.com");
    const task = scheduled(creator, {
      conversationAccess: { audience: "channel", visibility: "private" },
      destination: { ...PUBLIC_CHANNEL, channelId: "CPRIVATE" },
      status: "blocked",
      statusReason: "Missing credentials.",
    });
    await fixture.conversationStore.recordActivity({
      conversationId: "slack:CPRIVATE:1.000001",
      destination: task.destination,
      nowMs: NOW_MS,
      source: "slack",
      visibility: "private",
    });
    await saveScheduledAutomation(getDb(), task);

    const [alert] = await alertApi(fixture, creator).alerts(task.id);
    expect(alert).toMatchObject({ visibility: "private" });
    expect((await alertApi(fixture, reader).item(alert!.id)).status).toBe(404);
  });

  it("adds the alert of an Automation that needed attention before alerts at the next heartbeat", async () => {
    const creator = await user("creator@example.com");
    const asCreator = alertApi(fixture, creator);
    const task = scheduled(creator, {
      status: "blocked",
      statusReason: "GitHub access expired.",
    });
    await saveScheduledAutomation(getDb(), task);
    // Before the cutover, a blocked Automation had no Review item.
    await getDb()
      .delete(juniorReviewItems)
      .where(eq(juniorReviewItems.ownerId, task.id));
    expect(await asCreator.alerts(task.id)).toEqual([]);

    await heartbeat();
    const [alert] = await asCreator.alerts(task.id);
    expect(alert).toMatchObject({
      body: "Blocked: GitHub access expired. Fix the problem, then resume it.",
    });

    // A dismissed alert stays closed at later heartbeats.
    expect((await asCreator.dismiss(alert!.id)).status).toBe(200);
    await heartbeat();
    expect(await asCreator.alerts(task.id)).toEqual([]);
  });

  it("syncs the alert of an event trigger with the plugins at each heartbeat", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const creator = await user("creator@example.com");
    const asCreator = alertApi(fixture, creator);
    await createEventAutomation(getDb(), {
      id: "event_digest",
      createdAtMs: NOW_MS,
      createdBy: { slackUserId: `U-${creator.email}` },
      creatorIdentityId: creator.identities.find(
        (identity) => identity.provider === "slack",
      )!.id,
      credentialMode: "creator",
      destination: PUBLIC_CHANNEL,
      destinationVisibility: "public",
      outcomes: [],
      task: { kind: "instruction", instruction: "Post a digest of the PR." },
      title: "PR digest",
      trigger: {
        namespace: "github",
        resourceType: "pull_request",
        identifier: "GETSENTRY/JUNIOR#42",
        label: "PR 42",
        events: ["pull_request.merged"],
      },
    });
    expect(await asCreator.alerts("event_digest")).toEqual([]);

    // GitHub events turn off without a webhook secret. Nothing writes the
    // Automation, so only the heartbeat sees the change.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    await heartbeat();
    const [alert] = await asCreator.alerts("event_digest");
    expect(alert!.body).toMatch(/^Trigger unavailable: /);
    expect((await asCreator.inbox()).count).toBe(1);

    // They come back, so the next heartbeat closes the alert.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    await heartbeat();
    expect(await asCreator.alerts("event_digest")).toEqual([]);
    expect((await asCreator.inbox()).count).toBe(0);

    // A delete closes any alert.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    await heartbeat();
    expect(await asCreator.alerts("event_digest")).toHaveLength(1);
    await deleteEventAutomation(getDb(), "event_digest");
    expect(await asCreator.alerts("event_digest")).toEqual([]);
  });
});
