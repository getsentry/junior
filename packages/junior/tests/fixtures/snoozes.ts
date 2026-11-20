import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import type { InboxSnoozeSubjectBody } from "@/api/schema/inbox-snooze";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { insertReviewItem } from "@/chat/review-items/store";
import type { ConversationFixture } from "./conversation";

export const ROOT = "slack:CSNOOZE:1.000001";
export const PRIVATE_ROOT = "slack:CSNOOZE:2.000001";
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

/**
 * Add an open action item for these assignees, linked to `conversationId`
 * and to `linkedConversationIds`. Another Conversation can add it, so it
 * gets a row of its own.
 */
export async function addItem(
  conversationId: string,
  assignees: User[],
  title: string,
  visibility: "private" | "public" = "public",
  ownerConversationId = conversationId,
  linkedConversationIds: string[] = [],
): Promise<string> {
  const item = await insertReviewItem(getDb(), {
    owner: { id: ownerConversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: assignees.map((assignee) => assignee.id),
    body: title,
    conversationIds: [conversationId, ...linkedConversationIds],
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

/** The pull request that `addPullRequestItem` names, and its Event id. */
export const PULL_REQUEST = {
  identifier: "getsentry/junior#1",
  url: "https://github.com/getsentry/junior/pull/1",
};

/**
 * Add an open action item for these Users about `PULL_REQUEST`. It is
 * public in the Slack workspace, so every User there can see it.
 */
export async function addPullRequestItem(
  conversationId: string,
  assignees: User[],
  title: string,
): Promise<string> {
  const item = await insertReviewItem(getDb(), {
    owner: { id: conversationId, kind: "conversation" },
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
    subject: { id: PULL_REQUEST.url, title, url: PULL_REQUEST.url },
    tenant: { provider: "slack", providerTenantId: "T123" },
    title,
    visibility: "public",
  });
  return item!.id;
}

/** Add an open notice for these Users. A notice waits on nobody. */
export async function addNotice(
  conversationId: string,
  assignees: User[],
  title: string,
): Promise<string> {
  const item = await insertReviewItem(getDb(), {
    owner: { id: conversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: assignees.map((assignee) => assignee.id),
    body: title,
    conversationIds: [conversationId],
    dedupeKey: title,
    kind: "notice",
    nowMs: Date.now(),
    title,
    visibility: "public",
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
  const snoozes = (method: "DELETE" | "POST", body: unknown) =>
    app.request("http://localhost/api/inbox/snoozes", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method,
    });
  return {
    /** Read one API path, with these request headers. */
    request: (path: string, headers?: Record<string, string>) =>
      app.request(`http://localhost/api${path}`, { headers }),
    /** Snooze a row until this time. */
    snooze: (subject: InboxSnoozeSubjectBody, wakeAtMs: number) =>
      snoozes("POST", { ...subject, wakeAt: new Date(wakeAtMs).toISOString() }),
    /** Snooze a row until an Event on each item's subject. */
    snoozeOn: (
      subject: InboxSnoozeSubjectBody,
      triggers: { eventType: string; outcome: "resolve" | "wake" }[],
      wakeAtMs?: number,
    ) =>
      snoozes("POST", {
        ...subject,
        triggers,
        // JSON leaves out an unset time.
        wakeAt: wakeAtMs ? new Date(wakeAtMs).toISOString() : undefined,
      }),
    /** The subject of each item in the viewer's Inbox. */
    subjects: async () =>
      (
        (await json("/review-items?for=viewer")) as {
          items: { subject?: unknown }[];
        }
      ).items.map((item) => item.subject),
    unsnooze: (subject: InboxSnoozeSubjectBody) => snoozes("DELETE", subject),
    /** What Snoozed shows: its count and its item titles. */
    snoozed: async () => ({
      count: (
        (await json("/review-items/count?include=snoozed")) as {
          snoozed: number;
        }
      ).snoozed,
      items: (
        (await json("/review-items?for=viewer&snoozed=true")) as {
          items: { title: string }[];
        }
      ).items.map((item) => item.title),
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

/** What Snoozed shows when nothing is snoozed. */
export const NOTHING_SNOOZED = { count: 0, items: [] };
