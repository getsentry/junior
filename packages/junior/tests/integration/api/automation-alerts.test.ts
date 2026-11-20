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
  getEventAutomation,
} from "@/chat/event-automations/store";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import {
  readScheduledAutomation,
  saveScheduledAutomation,
} from "@/chat/scheduled-automations/tasks";
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
  request?: { fields: { options: { label: string }[] }[] };
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
    /** The Automations badge count. */
    badge: async () => {
      const response = await app.request(
        "http://localhost/api/review-items/count?include=automations",
      );
      return ((await response.json()) as { automations: number }).automations;
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
    /** Pick one step of an alert, such as Run again. */
    step: (id: string, label: string) =>
      app.request(`http://localhost/api/review-items/${id}/actions`, {
        body: JSON.stringify({
          action: "submit",
          answer: { values: { step: [label] } },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
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

    // A dismissed alert hides the Automation's alerts until it recovers,
    // even for a new failure or a new block.
    expect((await asCreator.dismiss(failed!.id)).status).toBe(200);
    await saveScheduledAutomation(getDb(), { ...task, status: "paused" });
    await saveScheduledAutomation(getDb(), { ...task, status: "active" });
    await recordAutomationExecution(task.id, {
      executionId: "run-2",
      nowMs: NOW_MS + 1,
      status: "failed",
    });
    await saveScheduledAutomation(getDb(), {
      ...task,
      status: "blocked",
      statusReason: "Slack access expired.",
    });
    expect(await asCreator.alerts(task.id)).toEqual([]);
    expect(await asCreator.todoAlerts()).toEqual([]);
    // The Automations badge counts what its To do lists.
    expect(await asCreator.badge()).toBe(0);

    // A resume and a run that completes recover it. The next problem opens a
    // fresh alert.
    vi.setSystemTime(NOW_MS + HOUR_MS);
    await saveScheduledAutomation(getDb(), { ...task, status: "active" });
    await recordAutomationExecution(task.id, {
      executionId: "run-3",
      nowMs: NOW_MS + HOUR_MS,
      status: "completed",
    });
    expect(await asCreator.alerts(task.id)).toEqual([]);
    await recordAutomationExecution(task.id, {
      executionId: "run-4",
      nowMs: NOW_MS + HOUR_MS + 1,
      status: "failed",
    });
    const [again] = await asCreator.alerts(task.id);
    expect(again).toMatchObject({ body: "Last run failed." });
    expect(again!.id).not.toBe(failed!.id);

    // A run that completes closes it, and core's close hides nothing.
    await recordAutomationExecution(task.id, {
      executionId: "run-5",
      nowMs: NOW_MS + HOUR_MS + 2,
      status: "completed",
    });
    expect(await asCreator.alerts(task.id)).toEqual([]);
    expect(await asCreator.todoAlerts()).toEqual([]);
    await recordAutomationExecution(task.id, {
      executionId: "run-6",
      nowMs: NOW_MS + HOUR_MS + 3,
      status: "failed",
    });
    expect(await asCreator.todoAlerts()).toEqual(["Daily digest"]);
    expect(await asCreator.badge()).toBe(1);
  });

  it("runs again or pauses an Automation from its failed-run alert", async () => {
    const creator = await user("creator@example.com");
    const asCreator = alertApi(fixture, creator);
    const task = scheduled(creator);
    await saveScheduledAutomation(getDb(), task);
    const steps = (alert: Alert | undefined) =>
      alert?.request?.fields[0]?.options.map((option) => option.label);

    await recordAutomationExecution(task.id, {
      errorMessage: "Slack rejected the message.",
      executionId: "run-1",
      nowMs: NOW_MS,
      status: "failed",
    });
    const [failed] = await asCreator.alerts(task.id);
    expect(steps(failed)).toEqual(["Run again", "Pause"]);

    // Run again queues a run now, as a manual run does, and closes the
    // alert. Only a new problem opens another one.
    expect((await asCreator.step(failed!.id, "Run again")).status).toBe(200);
    expect(await readScheduledAutomation(getDb(), task.id)).toMatchObject({
      runNowAtMs: NOW_MS,
      status: "active",
    });
    expect((await asCreator.item(failed!.id)).body).toMatchObject({
      status: "done",
    });
    expect(await asCreator.alerts(task.id)).toEqual([]);

    // Pause pauses it, so no alert opens.
    await recordAutomationExecution(task.id, {
      executionId: "run-2",
      nowMs: NOW_MS + 1,
      status: "failed",
    });
    const [again] = await asCreator.alerts(task.id);
    expect(again!.id).not.toBe(failed!.id);
    expect((await asCreator.step(again!.id, "Pause")).status).toBe(200);
    expect(await readScheduledAutomation(getDb(), task.id)).toMatchObject({
      status: "paused",
    });
    expect(await asCreator.alerts(task.id)).toEqual([]);
    expect(await asCreator.todoAlerts()).toEqual([]);

    // An event Automation runs only on its events, so it can only pause.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    await createEventAutomation(getDb(), {
      id: "event_digest",
      createdAtMs: NOW_MS,
      createdBy: { slackUserId: `U-${creator.email}` },
      creatorIdentityId: task.creatorIdentityId,
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
    await recordAutomationExecution("event_digest", {
      executionId: "event-run-1",
      nowMs: NOW_MS,
      status: "failed",
    });
    const [eventAlert] = await asCreator.alerts("event_digest");
    expect(steps(eventAlert)).toEqual(["Pause"]);
    expect((await asCreator.step(eventAlert!.id, "Pause")).status).toBe(200);
    expect(await getEventAutomation(getDb(), "event_digest")).toMatchObject({
      status: "paused",
    });
    expect(await asCreator.alerts("event_digest")).toEqual([]);
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

    // A dismissed alert hides the next ones until the trigger works again.
    // Its last run succeeded, so a working trigger is a recovery.
    await recordAutomationExecution("event_digest", {
      executionId: "event-run-1",
      nowMs: NOW_MS,
      status: "completed",
    });
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    await heartbeat();
    const [lost] = await asCreator.alerts("event_digest");
    expect((await asCreator.dismiss(lost!.id)).status).toBe(200);
    await heartbeat();
    expect(await asCreator.alerts("event_digest")).toEqual([]);
    vi.setSystemTime(NOW_MS + HOUR_MS);
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    await heartbeat();

    // A delete closes any alert.
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    await heartbeat();
    expect(await asCreator.alerts("event_digest")).toHaveLength(1);
    await deleteEventAutomation(getDb(), "event_digest");
    expect(await asCreator.alerts("event_digest")).toEqual([]);
  });
});
