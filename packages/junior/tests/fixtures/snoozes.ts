import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
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

/** Add an open notice for these Users. A notice waits on nobody. */
export async function addNotice(
  conversationId: string,
  assignees: User[],
  title: string,
): Promise<string> {
  const item = await insertReviewItem(getDb(), {
    addedByConversationId: conversationId,
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
    /** Snooze a row until this time. */
    snooze: (
      subject: { conversationId: string; reviewItemId?: string },
      wakeAtMs: number,
    ) =>
      snoozes("POST", { ...subject, wakeAt: new Date(wakeAtMs).toISOString() }),
    unsnooze: (subject: { conversationId: string; reviewItemId?: string }) =>
      snoozes("DELETE", subject),
    /** The titles in the viewer's Snoozed view. */
    snoozed: async () =>
      (
        (await json("/review-items?for=viewer&snoozed=true")) as {
          items: { title: string }[];
        }
      ).items.map((item) => item.title),
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
