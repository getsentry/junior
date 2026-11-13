import { createMemoryState } from "@chat-adapter/state-memory";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { createEventAppPublisher } from "@/chat/events/app-publisher";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { insertReviewItem } from "@/chat/review-items/store";
import type { ConversationFixture } from "./conversation";
import { useGitHubEvents } from "./event-automations";

export const ROOT = "slack:CSNOOZE:1.000001";
export const PRIVATE_ROOT = "slack:CSNOOZE:2.000001";
const PR = "getsentry/junior#7";
export const NOW_MS = Date.parse("2026-10-01T12:00:00.000Z");

/** A dashboard User with one linked Slack identity. */
export async function user(email: string): Promise<User> {
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

/** Record a Slack root Conversation. */
export async function conversation(
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

/** Add an open action item for these assignees. */
export async function addItem(
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

/** Call the dashboard API as one viewer. */
export function api(fixture: ConversationFixture, viewer: User) {
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

export const NEW_ITEM = { kind: "new_item" } as const;

/** A timer trigger that fires at this time. */
export function timer(firesAtMs: number) {
  return {
    kind: "event",
    namespace: "junior",
    resourceType: "timer",
    events: ["timer.fired"],
    firesAt: new Date(firesAtMs).toISOString(),
  } as const;
}

/**
 * Snooze a row until `getsentry/junior#7` is reviewed, then ask the app's
 * Event publisher about two Events and publish the review. Returns what the
 * snoozer saw at each step. Call `vi.unstubAllEnvs()` after the test.
 */
export async function wakeOnPullRequestReview(fixture: ConversationFixture) {
  await useGitHubEvents();
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
  const snoozedCount = (await asAna.inbox()).count;
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
  const mergedMatches = await publisher.hasMatch([
    event("pull_request.merged"),
  ]);
  const reviewMatches = await publisher.hasMatch([
    event("pull_request.review.approved"),
  ]);
  await publisher.publish(event("pull_request.review.approved"));
  return {
    created: created.status,
    mergedMatches,
    queued: fixture.queue.sentRecords().length,
    reviewMatches,
    snoozedCount,
    wokeCount: (await asAna.inbox()).count,
  };
}

/** What `wakeOnPullRequestReview` returns when the review wakes the row. */
export const PULL_REQUEST_REVIEW_WAKES = {
  created: 201,
  // The webhook publishes only when something matches.
  mergedMatches: false,
  // A wake runs no Turn.
  queued: 0,
  reviewMatches: true,
  snoozedCount: 0,
  wokeCount: 1,
};
