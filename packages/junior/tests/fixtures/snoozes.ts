import { generateKeyPairSync } from "node:crypto";
import type { User } from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";
import type { InboxSnoozeSubjectBody } from "@/api/schema/inbox-snooze";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { getConversationStore, getDb, getSqlExecutor } from "@/chat/db";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { insertInboxItem } from "@/chat/inbox-items/store";
import { mswServer } from "../msw/server";
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
  const item = await insertInboxItem(getDb(), {
    subject: { id: title, kind: "question" },
    owner: { id: ownerConversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: assignees.map((assignee) => assignee.id),
    body: title,
    conversationIds: [conversationId, ...linkedConversationIds],
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

/** Another pull request in the repository of `PULL_REQUEST`. */
export const OTHER_PULL_REQUEST = {
  identifier: "getsentry/junior#2",
  url: "https://github.com/getsentry/junior/pull/2",
};

/** A pull request of getsentry/junior that does not exist. */
const MISSING_PULL_REQUEST_NUMBER = "999";
export const MISSING_PULL_REQUEST_URL = `https://github.com/getsentry/junior/pull/${MISSING_PULL_REQUEST_NUMBER}`;

/** Link a GitHub login to a User, as account linking does. */
export async function linkGitHub(viewer: User, login: string): Promise<User> {
  await upsertLinkedIdentity(getSqlExecutor(), viewer.id, {
    handle: login,
    kind: "user",
    provider: "github",
    providerSubjectId: `gh-${login}`,
  });
  return (await resolveViewerUserFromSql(getDb(), viewer.email))!;
}

/**
 * Let the GitHub App read pull requests of getsentry/junior, except
 * `MISSING_PULL_REQUEST_URL`, and let only these GitHub logins see the
 * repository.
 */
export function useGitHubRepository(readers: string[]): void {
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
  vi.stubEnv(
    "GITHUB_APP_PRIVATE_KEY",
    generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs1" })
      .toString(),
  );
  const api = "https://api.github.com/repos/getsentry/junior";
  mswServer.use(
    http.get(`${api}/collaborators/:login/permission`, ({ params }) =>
      HttpResponse.json({
        permission: readers.includes(String(params["login"])) ? "read" : "none",
      }),
    ),
    http.get(`${api}/pulls/:number`, ({ params }) =>
      params["number"] === MISSING_PULL_REQUEST_NUMBER
        ? HttpResponse.json({ message: "Not Found" }, { status: 404 })
        : HttpResponse.json({
            html_url: `https://github.com/getsentry/junior/pull/${params["number"]}`,
            merged: false,
            number: Number(params["number"]),
            state: "open",
            title: `Pull request ${params["number"]}`,
          }),
    ),
  );
}

/**
 * Add an open action item for these Users about `PULL_REQUEST`. It is
 * public in the Slack workspace, so every User there can see it.
 */
export async function addPullRequestItem(
  conversationId: string,
  assignees: User[],
  title: string,
  url = PULL_REQUEST.url,
): Promise<string> {
  const item = await insertInboxItem(getDb(), {
    owner: { id: conversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: assignees.map((assignee) => assignee.id),
    body: title,
    conversationIds: [conversationId],
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
      // A question about a pull request cites it as evidence.
      evidence: [{ label: "Pull request", url }],
    },
    subject: { id: `review:${url}:${title}`, kind: "question" },
    tenant: { provider: "slack", providerTenantId: "T123" },
    title,
    visibility: "public",
  });
  return item!.id;
}

/** Add an open action item for Everyone. Anyone in the workspace can act. */
export async function addEveryoneItem(
  conversationId: string,
  title: string,
): Promise<string> {
  const item = await insertInboxItem(getDb(), {
    subject: { id: title, kind: "question" },
    owner: { id: conversationId, kind: "conversation" },
    assignedToEveryone: true,
    assigneeUserIds: [],
    body: title,
    conversationIds: [conversationId],
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
  const item = await insertInboxItem(getDb(), {
    subject: { id: title, kind: "question" },
    owner: { id: conversationId, kind: "conversation" },
    assignedToEveryone: false,
    assigneeUserIds: assignees.map((assignee) => assignee.id),
    body: title,
    conversationIds: [conversationId],
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
    /** Read one API path as JSON. */
    json,
    /** Read one API path, with these request headers. */
    request: (path: string, headers?: Record<string, string>) =>
      app.request(`http://localhost/api${path}`, { headers }),
    /** Snooze a row until this time. */
    snooze: (subject: InboxSnoozeSubjectBody, wakeAtMs: number) =>
      snoozes("POST", { ...subject, wakeAt: new Date(wakeAtMs).toISOString() }),
    /** Post this snooze body as it is, such as `untilClosed`. */
    postSnooze: (body: unknown) => snoozes("POST", body),
    /** The Events of a page that the viewer names for a snooze. */
    resource: (url: string) =>
      app.request(
        `http://localhost/api/inbox/snoozes/resource?${new URLSearchParams({ url })}`,
      ),
    /** Snooze a row until an Event on each item's subject or a named page. */
    snoozeOn: (
      subject: InboxSnoozeSubjectBody,
      triggers: {
        eventType: string;
        outcome: "resolve" | "wake";
        resourceUrl?: string;
      }[],
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
        (await json("/inbox-items?for=viewer")) as {
          items: { subject?: unknown }[];
        }
      ).items.map((item) => item.subject),
    unsnooze: (subject: InboxSnoozeSubjectBody) => snoozes("DELETE", subject),
    /** Why each item in the viewer's Inbox woke, by title. */
    wakes: async () =>
      Object.fromEntries(
        (
          (await json("/inbox-items?for=viewer")) as {
            items: { title: string; wake?: unknown }[];
          }
        ).items.map((item) => [item.title, item.wake]),
      ),
    /** Open these items, so they no longer say why they woke. */
    openWoken: (inboxItemIds: string[]) =>
      app.request("http://localhost/api/inbox/snoozes/wakes", {
        body: JSON.stringify({ inboxItemIds }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }),
    /** Take, answer, or dismiss an item. */
    act: (inboxItemId: string, body: unknown) =>
      app.request(`http://localhost/api/inbox-items/${inboxItemId}/actions`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    /** What Snoozed shows: its count and its item titles. */
    snoozed: async () => ({
      count: (
        (await json("/inbox-items/count?include=snoozed")) as {
          snoozed: number;
        }
      ).snoozed,
      items: (
        (await json("/inbox-items?for=viewer&snoozed=true")) as {
          items: { title: string }[];
        }
      ).items.map((item) => item.title),
    }),
    /** Every Inbox number: the badge, the waiting list and the Inbox list. */
    inbox: async () => ({
      count: ((await json("/inbox-items/count")) as { needsViewer: number })
        .needsViewer,
      inbox: (
        (await json("/inbox-items?for=viewer")) as {
          items: { title: string }[];
        }
      ).items.map((item) => item.title),
      waiting: (
        (await json("/inbox-items/waiting-conversations")) as {
          conversations: { conversationId: string }[];
        }
      ).conversations.map((row) => row.conversationId),
    }),
    versions: async () =>
      ((await json("/versions")) as { inboxItems: string }).inboxItems,
  };
}

/** What Snoozed shows when nothing is snoozed. */
export const NOTHING_SNOOZED = { count: 0, items: [] };
