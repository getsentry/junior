import { createAddInboxItemTool } from "@/chat/inbox-items/tools/add";
import type { User } from "@sentry/junior-plugin-api";
import { seedDashboardScale } from "../../../fixtures/dashboard-scale";
import { expectSqlBudget } from "../../../fixtures/sql-budget";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import { recordCodeChange } from "@/chat/code/store";
import { projectConversationMessages } from "@/chat/conversations/message-projection";
import { loadTurnConversationNotes } from "@/chat/conversations/notes";
import { getTurnLifecycle } from "@/chat/conversations/turn-lifecycle";
import {
  getConversationEventStore,
  getConversationStore,
  getDb,
} from "@/chat/db";
import { resolveViewerUserFromSql } from "@/chat/plugins/viewer";
import { sendInboxItemMessages } from "@/chat/inbox-items/messages";
import {
  closeInboxItem,
  getInboxItem,
  insertInboxItem,
  takeInboxItem,
} from "@/chat/inbox-items/store";
import { juniorIdentities } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { useAppContext } from "../../../fixtures/app-context";
import { avatarPath } from "../../../fixtures/avatar";
import { createSlackInboxItemToolServices } from "@/chat/slack/inbox-item-tools";
import { getConversation } from "@/chat/task-execution/store";
import type { UserInputRequest } from "@/chat/inbox-items/user-input-request";
import {
  closeConversationFixture,
  createConversationFixture,
  type ConversationFixture,
} from "../../../fixtures/conversation";
import { createConversationWorkQueueTestAdapter } from "../../../fixtures/conversation-work";

const CLI_CONVERSATION_ID = "local:cli:inbox-items";

const REQUEST: UserInputRequest = {
  question: "Approve or reject this entry?",
  fields: [
    {
      id: "decision",
      kind: "choice",
      label: "Decision",
      options: [{ label: "Approve" }, { label: "Reject" }],
    },
    { id: "reason", kind: "text", label: "Reason" },
  ],
};

/** A person signed in to the dashboard, linked to Slack workspace T123. */
async function user(email: string): Promise<User> {
  const resolved = await resolveViewerUserFromSql(getDb(), email);
  if (!resolved) throw new Error(`no user for ${email}`);
  return {
    ...resolved,
    identities: [
      {
        id: `identity:slack:${email}`,
        provider: "slack",
        providerSubjectId: `U-${email}`,
        providerTenantId: "T123",
      },
    ],
  };
}

async function slackConversation(conversationId: string): Promise<void> {
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: "T123", channelId: "CPUB" },
    nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
    source: "slack",
    visibility: "public",
  });
}

async function addItem(input: Record<string, unknown>): Promise<string> {
  const tool = createAddInboxItemTool(
    {
      conversationId: "slack:CPUB:1.000001",
      resolveActorIdentity: async () => undefined,
      source: { kind: "scheduled_automation" },
    },
    createSlackInboxItemToolServices(createConversationWorkQueueTestAdapter),
  );
  const result = await (tool as any).execute(input, {});
  return result.item.id;
}

function api(fixture: ConversationFixture, viewer: User) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi({ conversationWorkQueue: fixture.queue }));
  return {
    act: (id: string, body: unknown) =>
      app.request(`http://localhost/api/inbox-items/${id}/actions`, {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    get: (path: string) =>
      app.request(`http://localhost/api/inbox-items${path}`),
  };
}

async function pendingMessages(conversationId: string) {
  const conversation = await getConversation({ conversationId });
  return conversation?.execution.pendingMessages ?? [];
}

async function savedChanges(
  conversationId: string,
  kind: "taken" | "dismissed",
) {
  const messages = projectConversationMessages(
    await getConversationEventStore().loadMessageHistory(conversationId),
  );
  return messages.filter((message) =>
    message.meta?.reviewItemChanges?.some((change) => change.kind === kind),
  );
}

async function pendingTexts(conversationId: string): Promise<string[]> {
  return (await pendingMessages(conversationId)).map(
    (message) => message.input.text,
  );
}

describe("inbox item actions API", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("lists each waiting conversation once, with its items newest first", async () => {
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    const ana = await user("ana@example.com");
    const acmeId = await addItem({
      kind: "action",
      title: "Review acme entry",
      body: "The acme entry changed its license.",
      assignees: ["ana@example.com"],
      request: REQUEST,
    });
    // Created later, so it is the newest item.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await addItem({
      kind: "action",
      title: "Review globex entry",
      body: "The globex entry changed its license.",
      assignees: ["ana@example.com"],
      request: REQUEST,
    });

    // A child agent links its items to its own conversation. The root waits
    // on Ana.
    await slackConversation("slack:CPUB:1.000004");
    await getConversationStore().createChild({
      childConversationId: "agent:child-of-4",
      kind: "task",
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      parentConversationId: "slack:CPUB:1.000004",
    });
    await insertInboxItem(getDb(), {
      subject: { id: "fair-source:entry:initech", kind: "question" },
      owner: { id: "agent:child-of-4", kind: "conversation" },
      assignedToEveryone: false,
      assigneeUserIds: [ana.id],
      body: "The initech entry changed its license.",
      conversationIds: ["agent:child-of-4"],
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
        question: "Approve or reject this entry?",
      },
      title: "Review initech entry",
    });

    expect(
      await (
        await expectSqlBudget(
          () => api(fixture, ana).get("/waiting-conversations"),
          { statements: 1, serialRounds: 1 },
        )
      ).json(),
    ).toEqual({
      conversations: [
        {
          conversationId: "slack:CPUB:1.000001",
          items: [
            { title: "Review globex entry" },
            { title: "Review acme entry" },
          ],
          // The wait began with the oldest item.
          waitingSince: (await getInboxItem(
            getDb(),
            acmeId,
          ))!.createdAt.toISOString(),
        },
        {
          conversationId: "slack:CPUB:1.000004",
          items: [{ title: "Review initech entry" }],
          waitingSince: expect.any(String),
        },
      ],
    });
  });

  it("names the people that an item mentions, with their photos", async () => {
    const fixture = await createConversationFixture();
    const ana = await user("ana@example.com");
    await getConversationStore().recordActivity({
      actor: {
        email: "bea@example.com",
        fullName: "Bea Owner",
        platform: "slack",
        slackUserId: "UBEA1",
        teamId: "T123",
      },
      conversationId: "slack:CPUB:1.000001",
      destination: { platform: "slack", teamId: "T123", channelId: "CPUB" },
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      source: "slack",
      visibility: "public",
    });
    const [bea] = await getDb()
      .update(juniorIdentities)
      .set({ avatarUrl: "https://avatars.slack-edge.com/bea_512.png" })
      .where(
        and(
          eq(juniorIdentities.provider, "slack"),
          eq(juniorIdentities.providerSubjectId, "UBEA1"),
        ),
      )
      .returning({ id: juniorIdentities.id });
    await addItem({
      kind: "action",
      title: "Ask <@UBEA1> about acme",
      body: "<@UBEA1> owns the acme entry.",
      assignees: ["ana@example.com"],
      request: { ...REQUEST, question: "Did <@UBEA1> approve it?" },
    });

    // The names and photos come with the items, in one more statement.
    await seedDashboardScale();
    const { items } = await (
      await expectSqlBudget(() => api(fixture, ana).get("?for=viewer"), {
        statements: 6,
        serialRounds: 4,
      })
    ).json();
    expect(items).toMatchObject([
      {
        mentions: [
          {
            avatarUrl: avatarPath(bea!.id),
            email: "bea@example.com",
            fullName: "Bea Owner",
            slackUserId: "UBEA1",
          },
        ],
        title: "Ask <@UBEA1> about acme",
      },
    ]);
  });

  it("closes an action item for every assignee on the first submit", async () => {
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    await slackConversation("slack:CPUB:1.000002");
    await slackConversation("slack:CPUB:1.000003");
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    const cal = await user("cal@example.com");
    const id = await addItem({
      kind: "action",
      title: "Review acme entry",
      body: "The acme entry changed its license.",
      assignees: ["ana@example.com", "ben@example.com"],
      conversation_ids: ["slack:CPUB:1.000002"],
      request: REQUEST,
    });
    // A notice does not need Ana, so it does not count.
    const noticeId = await addItem({
      kind: "notice",
      title: "Weekly report is ready",
      body: "Read it when you have time.",
      assignees: ["ana@example.com"],
      conversation_ids: ["slack:CPUB:1.000003"],
    });

    await seedDashboardScale();
    const anaCount = await (
      await expectSqlBudget(() => api(fixture, ana).get("/count"), {
        statements: 1,
        serialRounds: 1,
      })
    ).json();
    expect(anaCount).toEqual({
      decisions: 1,
      needsViewer: 1,
      codeChanges: 0,
      snoozed: 0,
      todos: 0,
    });
    // The Conversations of the action item wait on Ana, but not on Cal.
    expect(
      await (await api(fixture, ana).get("/waiting-conversations")).json(),
    ).toEqual({
      conversations: [
        {
          conversationId: "slack:CPUB:1.000001",
          items: [{ title: "Review acme entry" }],
          waitingSince: expect.any(String),
        },
        {
          conversationId: "slack:CPUB:1.000002",
          items: [{ title: "Review acme entry" }],
          waitingSince: expect.any(String),
        },
      ],
    });
    expect(
      await (await api(fixture, cal).get("/waiting-conversations")).json(),
    ).toEqual({ conversations: [] });
    const calList = await (await api(fixture, cal).get("")).json();
    expect(calList.items).toHaveLength(2);
    expect(calList.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "notice" }),
        // Cal can see the public question, so he can answer it.
        expect.objectContaining({ id, canAct: false, canAnswer: true }),
      ]),
    );
    // The inbox list drops the items that are assigned only to others.
    expect(
      (await (await api(fixture, cal).get("?for=viewer")).json()).items,
    ).toEqual([]);
    expect(
      (await (await api(fixture, ana).get("?for=viewer")).json()).items,
    ).toHaveLength(2);
    // A person outside the Slack workspace does not see the public item.
    const outsider = { ...cal, identities: [] };
    expect((await (await api(fixture, outsider).get("")).json()).items).toEqual(
      [],
    );
    // Only a public question opens to its readers. Cal cannot dismiss a
    // notice for Ana.
    expect(
      (await api(fixture, cal).act(noticeId, { action: "dismiss" })).status,
    ).toBe(403);

    const submitted = await api(fixture, ana).act(id, {
      action: "submit",
      answer: { values: { decision: ["Reject"], reason: ["Not fair source"] } },
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      status: "done",
      canAct: false,
      closedBy: { email: "ana@example.com" },
      answer: { values: { decision: ["Reject"], reason: ["Not fair source"] } },
    });

    // Both linked Conversations hear from Ana, once, even after a retry.
    const retry = await api(fixture, ana).act(id, {
      action: "submit",
      answer: { values: { decision: ["Reject"] } },
    });
    expect(retry.status).toBe(200);
    for (const conversationId of [
      "slack:CPUB:1.000001",
      "slack:CPUB:1.000002",
    ]) {
      const texts = await pendingTexts(conversationId);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toContain("ana@example.com answered inbox item");
      expect(texts[0]).toContain("Not fair source");
      // The message records the answer, so the dashboard shows it as one.
      expect(
        (await pendingMessages(conversationId))[0]?.input.reviewItemChange,
      ).toEqual({ kind: "submitted", reviewItemId: id });
    }

    // Ben is too late, and the item leaves the open views.
    expect(
      (await api(fixture, ben).act(id, { action: "dismiss" })).status,
    ).toBe(409);
    expect(await (await api(fixture, ben).get("/count")).json()).toEqual({
      decisions: 0,
      needsViewer: 0,
      codeChanges: 0,
      snoozed: 0,
      todos: 0,
    });
    expect(
      await (await api(fixture, ben).get("/waiting-conversations")).json(),
    ).toEqual({ conversations: [] });
    // The list still shows every open item that Ben can see.
    expect(
      (await (await api(fixture, ben).get("")).json()).items,
    ).toMatchObject([{ kind: "notice" }]);
    // A search still finds the closed item.
    const found = await (await api(fixture, ben).get("?q=acme")).json();
    expect(found.items).toMatchObject([{ id, status: "done" }]);
    // The inbox asks for archived items without a search.
    const all = await (await api(fixture, ben).get("?include=archived")).json();
    expect(all.items).toMatchObject([
      { kind: "notice" },
      { id, status: "done" },
    ]);

    // The Done list pages the closed items, newest closed first, with the
    // same visibility as open items.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const notice = calList.items.find((item: any) => item.kind === "notice");
    expect(
      (await api(fixture, ana).act(notice.id, { action: "dismiss" })).status,
    ).toBe(200);
    const closedPage = await (
      await api(fixture, ana).get("?status=done,dismissed&limit=1")
    ).json();
    expect(closedPage.items).toMatchObject([
      { id: notice.id, status: "dismissed" },
    ]);
    const closedCursor = encodeURIComponent(closedPage.nextCursor);
    const nextClosed = await (
      await api(fixture, ana).get(
        `?status=done,dismissed&limit=1&cursor=${closedCursor}`,
      )
    ).json();
    expect(nextClosed.items).toMatchObject([{ id, status: "done" }]);
    expect(nextClosed.nextCursor).toBeUndefined();
    // A cursor pages only its own list.
    expect(
      (await api(fixture, ana).get(`?limit=1&cursor=${closedCursor}`)).status,
    ).toBe(400);
    expect(
      (await (await api(fixture, ana).get("?status=dismissed")).json()).items,
    ).toMatchObject([{ id: notice.id }]);
    expect(
      (
        await (
          await api(fixture, outsider).get("?status=done,dismissed")
        ).json()
      ).items,
    ).toEqual([]);
    expect((await api(fixture, ana).get("?status=open,done")).status).toBe(400);
    // Closed items never count.
    expect(await (await api(fixture, ana).get("/count")).json()).toEqual({
      decisions: 0,
      needsViewer: 0,
      codeChanges: 0,
      snoozed: 0,
      todos: 0,
    });
  });

  it("names the root and the child that added an item the viewer can see", async () => {
    const fixture = await createConversationFixture();
    const ana = await user("ana@example.com");
    const nowMs = Date.parse("2026-10-01T12:00:00.000Z");
    // A public root with a Thread, and a Task under the Thread.
    await slackConversation("slack:CPUB:1.000005");
    await getConversationStore().createChild({
      childConversationId: "agent:thread-of-5",
      kind: "thread",
      nowMs,
      parentConversationId: "slack:CPUB:1.000005",
      title: "Check the release notes",
    });
    await getConversationStore().createChild({
      childConversationId: "agent:task-of-thread-of-5",
      kind: "task",
      nowMs,
      parentConversationId: "agent:thread-of-5",
      title: "Read the canary logs",
    });
    // A private root where Ana takes no part, with a Thread.
    await getConversationStore().recordActivity({
      conversationId: "slack:CPRIV:1.000006",
      destination: { platform: "slack", teamId: "T123", channelId: "CPRIV" },
      nowMs,
      source: "slack",
      visibility: "private",
    });
    await getConversationStore().createChild({
      childConversationId: "agent:thread-of-6",
      kind: "thread",
      nowMs,
      parentConversationId: "slack:CPRIV:1.000006",
      title: "Rotate the private key",
    });
    const add = async (conversationId: string, title: string) => {
      const created = await insertInboxItem(getDb(), {
        subject: { id: `roll-up:${conversationId}`, kind: "question" },
        owner: { id: conversationId, kind: "conversation" },
        assignedToEveryone: false,
        assigneeUserIds: [ana.id],
        body: `${title}.`,
        conversationIds: [conversationId],
        kind: "notice",
        nowMs,
        title,
      });
      if (!created) throw new Error(`${title} was not added`);
      return created.id;
    };
    const rootItem = await add("slack:CPUB:1.000005", "Root notice");
    const threadItem = await add("agent:thread-of-5", "Thread notice");
    const taskItem = await add("agent:task-of-thread-of-5", "Task notice");
    // Ana sees this item as its assignee, but not the tree that added it.
    const hiddenItem = await add("agent:thread-of-6", "Private notice");

    const list = await (
      await expectSqlBudget(
        () => api(fixture, ana).get("?for=viewer&sort=waiting"),
        { statements: 9, serialRounds: 6 },
      )
    ).json();
    const byId = new Map<string, Record<string, unknown>>(
      list.items.map((item: { id: string }) => [item.id, item]),
    );
    const root = (id: string) => ({
      addedByLabel: byId.get(id)?.["addedByLabel"],
      rootConversationId: byId.get(id)?.["rootConversationId"],
    });
    // Every item names its root, a root item its own Conversation.
    expect(root(rootItem)).toEqual({
      addedByLabel: undefined,
      rootConversationId: "slack:CPUB:1.000005",
    });
    expect(root(threadItem)).toEqual({
      addedByLabel: "Check the release notes",
      rootConversationId: "slack:CPUB:1.000005",
    });
    // A child at any depth rolls up to its root.
    expect(root(taskItem)).toEqual({
      addedByLabel: "Read the canary logs",
      rootConversationId: "slack:CPUB:1.000005",
    });
    // Ana cannot see that root, so the item's own Conversation stands in.
    expect(root(hiddenItem)).toEqual({
      addedByLabel: undefined,
      rootConversationId: "agent:thread-of-6",
    });
    // One item's own read names its root too, as does an action's result.
    expect(
      (await (await api(fixture, ana).get(`/${taskItem}`)).json())[
        "rootConversationId"
      ],
    ).toBe("slack:CPUB:1.000005");
    expect(
      (
        await (
          await api(fixture, ana).act(threadItem, { action: "dismiss" })
        ).json()
      )["rootConversationId"],
    ).toBe("slack:CPUB:1.000005");
  });

  it("pages what waits on the viewer first with the waiting sort", async () => {
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    const ana = await user("ana@example.com");
    const base = Date.parse("2026-10-01T12:00:00.000Z");
    const item = async (
      index: number,
      kind: "action" | "notice",
      nowMs: number,
    ) => {
      const created = await insertInboxItem(getDb(), {
        subject: { id: `waiting-sort:${index}`, kind: "question" },
        owner: { id: "slack:CPUB:1.000001", kind: "conversation" },
        assignedToEveryone: false,
        assigneeUserIds: [ana.id],
        body: `Item ${index}.`,
        conversationIds: ["slack:CPUB:1.000001"],
        ...(kind === "action"
          ? {
              kind,
              request: {
                fields: [
                  {
                    id: "decision",
                    kind: "choice" as const,
                    label: "Decision",
                    options: [{ label: "Approve" }, { label: "Reject" }],
                  },
                ],
                question: "Approve or reject this entry?",
              },
            }
          : { kind }),
        nowMs,
        title: `Item ${index}`,
      });
      if (!created) throw new Error(`item ${index} was not added`);
      return created.id;
    };
    // 30 old notices, two at each time so the id breaks the tie, then one
    // new ask. Oldest first, the ask would be on the second page.
    const notices: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      notices.push(
        await item(index, "notice", base + Math.floor(index / 2) * 1_000),
      );
    }
    const ask = await item(30, "action", base + 60_000);

    const first = await (
      await expectSqlBudget(
        () => api(fixture, ana).get("?for=viewer&sort=waiting&limit=25"),
        { statements: 5, serialRounds: 4 },
      )
    ).json();
    expect(first.items[0]).toMatchObject({ id: ask, kind: "action" });
    expect(first.items).toHaveLength(25);
    const cursor = encodeURIComponent(first.nextCursor);
    const second = await (
      await api(fixture, ana).get(
        `?for=viewer&sort=waiting&limit=25&cursor=${cursor}`,
      )
    ).json();
    expect(second.nextCursor).toBeUndefined();
    // The rest page newest first, with no item twice and none skipped.
    const rest = [...first.items, ...second.items].slice(1) as {
      createdAt: string;
      id: string;
    }[];
    expect(rest.map((notice) => notice.id).sort()).toEqual([...notices].sort());
    const times = rest.map((notice) => Date.parse(notice.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
    // A cursor pages only the order it came from.
    expect(
      (await api(fixture, ana).get(`?for=viewer&limit=25&cursor=${cursor}`))
        .status,
    ).toBe(400);
  });

  it("counts each Inbox bundle across every page", async () => {
    // createApp installs its plugins; the next test starts without them.
    useAppContext();
    // The GitHub plugin's link types recognize pull request subjects.
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    const ana = await user("ana@example.com");
    const ben = await user("ben@example.com");
    const base = Date.parse("2026-10-01T12:00:00.000Z");
    const item = async (
      index: number,
      input: {
        assignee?: User;
        kind: "decision" | "notice" | "pr" | "prQuestion";
      },
    ) => {
      const pr = { id: `${1000 + index}`, kind: "github:pull_request" };
      const prUrl = `https://github.com/getsentry/junior/pull/${index}`;
      if (input.kind === "pr" || input.kind === "notice") {
        await recordCodeChange(getDb(), "github", {
          conversationIds: [],
          number: index,
          openedAt: new Date(base),
          providerId: pr.id,
          repository: { name: "getsentry/junior", providerId: "repository-1" },
          state: "open",
          title: `Change ${index}`,
          updatedAt: new Date(base),
        });
        // The opener's row names the Conversation that owns the item.
        await getDb().execute(
          sql`insert into junior_github_pull_request_requesters (repository_full_name, number, identity_id, conversation_id, pull_request_id, created_at, updated_at) values ('getsentry/junior', ${index}, 'identity:opener', 'slack:CPUB:1.000001', ${pr.id}, now(), now())`,
        );
      }
      const created = await insertInboxItem(getDb(), {
        owner: { id: "slack:CPUB:1.000001", kind: "conversation" },
        assignedToEveryone: false,
        assigneeUserIds: [(input.assignee ?? ana).id],
        body: `Item ${index}.`,
        conversationIds: ["slack:CPUB:1.000001"],
        ...(input.kind === "decision"
          ? {
              kind: "action",
              request: REQUEST,
              subject: { id: `bundles:${index}`, kind: "question" },
            }
          : input.kind === "pr"
            ? { kind: "action", subject: pr }
            : input.kind === "prQuestion"
              ? {
                  // A question about a pull request links it.
                  kind: "action",
                  request: {
                    ...REQUEST,
                    related: [{ label: "The pull request", url: prUrl }],
                  },
                  subject: { id: `bundles:${index}`, kind: "question" },
                }
              : { kind: "notice", subject: pr }),
        nowMs: base + index * 1_000,
        title: `Item ${index}`,
      });
      if (!created) throw new Error(`item ${index} was not added`);
      return created.id;
    };
    // 27 decisions and 2 pull requests wait on Ana: more than one page.
    for (let index = 0; index < 27; index += 1) {
      await item(index, { kind: "decision" });
    }
    await item(27, { kind: "pr" });
    await item(28, { kind: "prQuestion" });
    // A notice and Ben's pull request do not wait on Ana.
    await item(29, { kind: "notice" });
    await item(30, { assignee: ben, kind: "pr" });
    const closed = await item(31, { kind: "decision" });
    await closeInboxItem(getDb(), {
      id: closed,
      nowMs: base + 40_000,
      status: "done",
    });
    const first = await (
      await api(fixture, ana).get("?for=viewer&sort=waiting&limit=25")
    ).json();
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).toBeDefined();
    // Newest first. The question that cites a pull request has no card of
    // it: its related links do not decide its card.
    expect(
      first.items
        .slice(0, 3)
        .map(
          (listed: { subject: { objectType?: string } }) =>
            listed.subject.objectType,
        ),
    ).toEqual([undefined, "code_change", undefined]);

    // The counts cover every page.
    // The question that cites a pull request counts as a decision only:
    // pull requests count a code change's own asks.
    expect(await (await api(fixture, ana).get("/count")).json()).toEqual({
      decisions: 28,
      needsViewer: 29,
      codeChanges: 1,
      snoozed: 0,
      todos: 0,
    });
    expect(await (await api(fixture, ben).get("/count")).json()).toEqual({
      decisions: 0,
      needsViewer: 1,
      codeChanges: 1,
      snoozed: 0,
      todos: 0,
    });
  });

  it("lets anyone take an item assigned to Everyone", async () => {
    const fixture = await createConversationFixture();
    await slackConversation("slack:CPUB:1.000001");
    const cal = await user("cal@example.com");
    const id = await addItem({
      kind: "action",
      title: "Pull request needs review",
      body: "It waits on a reviewer.",
      assignees: ["everyone"],
      request: REQUEST,
    });

    const list = await (await api(fixture, cal).get("")).json();
    expect(list.items).toMatchObject([{ id, canAct: true, canTake: true }]);
    // An item for Everyone needs no one until a person takes it.
    expect(await (await api(fixture, cal).get("/count")).json()).toEqual({
      decisions: 0,
      needsViewer: 0,
      codeChanges: 0,
      snoozed: 0,
      todos: 0,
    });
    expect(
      await (await api(fixture, cal).get("/waiting-conversations")).json(),
    ).toEqual({ conversations: [] });

    // The next item is created later, so the list order is fixed.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const otherId = await addItem({
      kind: "notice",
      title: "Another pull request needs review",
      body: "It waits on a reviewer too.",
      assignees: ["everyone"],
    });

    // The list pages the open items, oldest first. A cursor reads the next
    // page of the same list only.
    const first = await (await api(fixture, cal).get("?limit=1")).json();
    expect(first.items).toMatchObject([{ id, canAct: true, canTake: true }]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const cursor = encodeURIComponent(first.nextCursor);
    const second = await (
      await api(fixture, cal).get(`?limit=1&cursor=${cursor}`)
    ).json();
    expect(second.items).toMatchObject([{ id: otherId }]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      (await api(fixture, cal).get(`?q=pull&limit=1&cursor=${cursor}`)).status,
    ).toBe(400);
    expect(
      (await api(fixture, cal).get(`?for=viewer&limit=1&cursor=${cursor}`))
        .status,
    ).toBe(400);
    const malformed = await api(fixture, cal).get("?limit=1&cursor=not-json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: "Invalid inbox item cursor.",
    });
    // A cursor that an open tab got before a deploy still reads its page.
    const tabCursor = Buffer.from(
      JSON.stringify({
        createdAtMs: Date.parse(first.items[0].createdAt),
        id,
        version: 2,
      }),
    ).toString("base64url");
    expect(
      (
        await (
          await api(fixture, cal).get(`?limit=1&cursor=${tabCursor}`)
        ).json()
      ).items,
    ).toMatchObject([{ id: otherId }]);
    // Items for Everyone stay in the inbox list.
    expect(
      (await (await api(fixture, cal).get("?for=viewer")).json()).items,
    ).toMatchObject([{ id }, { id: otherId }]);

    // The take committed, but its messages did not go out. A retry of the
    // take sends them.
    await takeInboxItem(getDb(), { id, nowMs: Date.now(), userId: cal.id });
    await api(fixture, cal).act(id, { action: "take" });
    const taken = await api(fixture, cal).act(id, { action: "take" });
    expect(await taken.json()).toMatchObject({
      assignedToEveryone: false,
      assignees: [{ email: "cal@example.com" }],
      canTake: false,
      status: "open",
    });
    expect(await (await api(fixture, cal).get("/count")).json()).toEqual({
      decisions: 1,
      needsViewer: 1,
      codeChanges: 0,
      snoozed: 0,
      todos: 0,
    });
    expect(
      await (await api(fixture, cal).get("/waiting-conversations")).json(),
    ).toEqual({
      conversations: [
        {
          conversationId: "slack:CPUB:1.000001",
          items: [{ title: "Pull request needs review" }],
          waitingSince: expect.any(String),
        },
      ],
    });
    // A take starts no Turn. The Conversation saves it as a handled
    // Message with its record, so the dashboard still shows it, and a later
    // answer does not change what it shows.
    expect(await pendingMessages("slack:CPUB:1.000001")).toEqual([]);
    expect(await savedChanges("slack:CPUB:1.000001", "taken")).toEqual([
      expect.objectContaining({
        text: expect.stringContaining("cal@example.com took inbox item"),
        meta: expect.objectContaining({
          reviewItemChanges: [{ kind: "taken", reviewItemId: id }],
        }),
      }),
    ]);
    // A local CLI Conversation saves it the same way.
    await getConversationStore().recordActivity({
      conversationId: CLI_CONVERSATION_ID,
      destination: { platform: "local", conversationId: CLI_CONVERSATION_ID },
      nowMs: Date.parse("2026-10-01T12:00:00.000Z"),
      source: "local",
      visibility: "public",
    });
    const item = await getInboxItem(getDb(), id);
    await sendInboxItemMessages({
      change: { kind: "taken", user: cal },
      item: { ...item!, conversationIds: [CLI_CONVERSATION_ID] },
      nowMs: Date.now(),
      queue: fixture.queue,
    });
    expect(await pendingMessages(CLI_CONVERSATION_ID)).toEqual([]);
    expect(await savedChanges(CLI_CONVERSATION_ID, "taken")).toHaveLength(1);

    // A dismiss also starts no Turn. It is saved the same way.
    const dismissed = await api(fixture, cal).act(id, { action: "dismiss" });
    expect(dismissed.status).toBe(200);
    expect(await pendingMessages("slack:CPUB:1.000001")).toEqual([]);
    // The Message names Cal's Identity, so the dashboard shows his photo.
    const [calIdentity] = await getDb()
      .select({ id: juniorIdentities.id })
      .from(juniorIdentities)
      .where(
        and(
          eq(juniorIdentities.provider, "junior"),
          eq(juniorIdentities.providerSubjectId, "cal@example.com"),
        ),
      );
    expect(await savedChanges("slack:CPUB:1.000001", "dismissed")).toEqual([
      expect.objectContaining({
        authorIdentityId: calIdentity!.id,
        text: expect.stringContaining("cal@example.com dismissed inbox item"),
        meta: expect.objectContaining({
          reviewItemChanges: [{ kind: "dismissed", reviewItemId: id }],
        }),
      }),
    ]);
    // The next Turn gets the dismiss as a note, so the agent does not keep
    // treating the item as open.
    await getTurnLifecycle().start({
      conversationId: "slack:CPUB:1.000001",
      createdAtMs: Date.now(),
      inputMessageIds: ["after-dismiss-message"],
      surface: "internal",
      turnId: "after-dismiss",
    });
    expect(
      await loadTurnConversationNotes({
        conversationId: "slack:CPUB:1.000001",
        turnId: "after-dismiss",
      }),
    ).toEqual([
      expect.stringMatching(
        new RegExp(
          `^cal@example\\.com dismissed inbox item .*\\(${id}\\)\\. It is closed with no answer\\.`,
        ),
      ),
    ]);
  });
});
