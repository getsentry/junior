import { randomUUID } from "node:crypto";
import { githubPlugin } from "@sentry/junior-github";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { searchReportSchema } from "@/api/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
import { recordCodeChange } from "@/chat/code/store";
import { closeInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { reembedMemories } from "@/chat/memory/reembed";
import { memoryDb } from "@/chat/memory/store";
import { createPluginEmbedder } from "@/chat/plugins/model";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import { changeTodos } from "@/chat/todos/store";
import type { TodoStatus } from "@/chat/todos/types";
import {
  fallbackShortTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { juniorConversationParticipants } from "@/db/schema";
import { juniorMemoryMemories } from "@/db/schema/memory";
import { readStats } from "@/stats";
import { mockEmbeddings } from "../../fixtures/retrieval-models";
import { expectResponseBudget } from "../../fixtures/response-budget";
import {
  expectNoFullScan,
  expectSqlBudget,
  measureSql,
} from "../../fixtures/sql-budget";

const TEAM_ID = "T123";
const VIEWER = { email: "ana@example.com", slackUserId: "UANA" };
const OTHER = { email: "bob@example.com", slackUserId: "UBOB" };
// The longest title that the add tool takes.
const INBOX_ITEM_TITLE_MAX_LENGTH = 200;
// The longest title that `todos_updateTodos` takes.
const TODO_TITLE_MAX_LENGTH = 200;
// Vectors of a stored size that the exact search reads.
const MEMORY_VECTOR = [1, ...Array<number>(1_535).fill(0)];
const UNRELATED_VECTOR = [0, 1, ...Array<number>(1_534).fill(0)];

/** Store a person with a Slack account in `T123`, and return their User. */
async function person(args: { email: string; slackUserId: string }) {
  await createSqlStore(getSqlExecutor()).recordActivity({
    actor: {
      email: args.email,
      platform: "slack",
      slackUserId: args.slackUserId,
      teamId: TEAM_ID,
    },
    conversationId: `slack:C123:${args.slackUserId}`,
    destination: { channelId: "C123", platform: "slack", teamId: TEAM_ID },
    visibility: "public",
  });
  const user = await resolveViewerUser(args.email);
  if (!user) throw new Error(`missing viewer for ${args.email}`);
  return user;
}

/** A dashboard API signed in as one person. */
function signedIn(viewer: NonNullable<Awaited<ReturnType<typeof person>>>) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return (q: string, sources = "inboxItems,automations") =>
    app.request(
      `http://localhost/api/search?${new URLSearchParams({ q, sources })}`,
    );
}

async function report(response: Response | Promise<Response>) {
  const awaited = await response;
  expect(awaited.status).toBe(200);
  return searchReportSchema.parse(await awaited.json());
}

async function inboxItem(args: {
  assigneeUserIds?: string[];
  body?: string;
  nowMs: number;
  title: string;
  visibility?: "private" | "public";
}) {
  const visibility = args.visibility ?? "private";
  // The item is as private as the channel of the Conversation that asked.
  const channelId = visibility === "public" ? "CASKPUB" : "CASKPRIV";
  const conversationId = `slack:${channelId}:1.000001`;
  await getConversationStore().recordActivity({
    conversationId,
    destination: { platform: "slack", teamId: TEAM_ID, channelId },
    nowMs: args.nowMs,
    source: "slack",
    visibility,
  });
  const item = await insertInboxItem(getDb(), {
    assignedToEveryone: false,
    assigneeUserIds: args.assigneeUserIds ?? [],
    body: args.body ?? "",
    conversationIds: [],
    subject: { id: args.title, kind: "question" },
    kind: "notice",
    nowMs: args.nowMs,
    owner: { id: conversationId, kind: "conversation" },
    title: args.title,
  });
  if (!item) throw new Error(`Inbox item ${args.title} was not stored`);
  return item;
}

async function automation(args: {
  creator: NonNullable<Awaited<ReturnType<typeof person>>>;
  id: string;
  instruction?: string;
  slackUserId: string;
  status?: "active" | "deleted";
  title?: string;
  visibility: "private" | "public";
}) {
  const identity = args.creator.identities.find(
    (candidate) => candidate.provider === "slack",
  );
  if (!identity) throw new Error(`missing Slack identity for ${args.id}`);
  const nowMs = Date.now();
  await saveScheduledAutomation(getDb(), {
    id: args.id,
    conversationAccess: { audience: "channel", visibility: args.visibility },
    createdAtMs: nowMs,
    createdBy: { slackUserId: args.slackUserId },
    creatorIdentityId: identity.id,
    credentialMode: "creator",
    destination: {
      channelId: args.visibility === "public" ? "C123" : "CPRIVATE",
      platform: "slack",
      teamId: TEAM_ID,
    },
    nextRunAtMs: nowMs + 60_000,
    outcomes: [],
    schedule: {
      description: "",
      kind: "recurring",
      recurrence: {
        frequency: "daily",
        interval: 1,
        startDate: new Date(nowMs).toISOString().slice(0, 10),
        time: { hour: 12, minute: 0 },
      },
      timezone: "UTC",
    },
    status: args.status ?? "active",
    task: { kind: "instruction", instruction: args.instruction ?? "Run it." },
    title: args.title,
    updatedAtMs: nowMs,
  });
}

type MemoryRow = typeof juniorMemoryMemories.$inferInsert;

/** Store an active public memory with a vector, then apply `changes`. */
async function memory(
  id: string,
  content: string,
  changes: Partial<MemoryRow> = {},
) {
  const db = memoryDb(getDb());
  const nowMs = Date.now();
  await db.insert(juniorMemoryMemories).values({
    content,
    createdAtMs: nowMs,
    id,
    kind: "knowledge",
    observedAtMs: nowMs,
    scope: "public",
    scopeKey: "public",
    sourceKey: "slack:T123:C123:1718800000.000000",
    sourcePlatform: "slack",
    subjectType: "general",
  });
  await reembedMemories({
    batchSize: 10,
    db,
    embedder: createPluginEmbedder("memory"),
  });
  if (Object.keys(changes).length > 0) {
    await db
      .update(juniorMemoryMemories)
      .set(changes)
      .where(eq(juniorMemoryMemories.id, id));
  }
}

/** Add To-dos to a stored Conversation, one change each, so each is newer. */
async function todos(
  conversationId: string,
  rows: readonly { status: TodoStatus; title: string }[],
) {
  for (const row of rows) {
    await changeTodos(getSqlExecutor(), {
      conversationId,
      nowMs: Date.now(),
      change: {
        add: [{ ...row, assignee: { conversationId } }],
        remove: [],
        update: [],
      },
    });
  }
}

/** Store a local root Conversation, with `participantId` as a Participant. */
async function rootConversation(args: {
  conversationId: string;
  participantId?: string;
  visibility: "private" | "public";
}) {
  await getConversationStore().recordActivity({
    conversationId: args.conversationId,
    destination: { platform: "local", conversationId: args.conversationId },
    nowMs: Date.now(),
    source: "internal",
    visibility: args.visibility,
  });
  if (args.participantId) {
    await getDb().insert(juniorConversationParticipants).values({
      lastMessageAt: new Date(),
      rootConversationId: args.conversationId,
      userId: args.participantId,
    });
  }
}

describe("search API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("finds the viewer's Inbox items by word prefixes of their title and body, and by a title typo", async () => {
    const viewer = await person(VIEWER);
    const other = await person(OTHER);
    await inboxItem({
      assigneeUserIds: [viewer.id],
      nowMs: 1_000,
      title: "Review the deploy freeze",
    });
    await inboxItem({
      assigneeUserIds: [viewer.id],
      nowMs: 2_000,
      title: "Deployment of payments-v42",
    });
    const closed = await inboxItem({
      assigneeUserIds: [viewer.id],
      nowMs: 3_000,
      title: "Deploy the docs",
    });
    await closeInboxItem(getDb(), {
      id: closed.id,
      nowMs: 4_000,
      status: "done",
    });
    // A public item in the viewer's Slack workspace, for anyone.
    await inboxItem({
      nowMs: 500,
      title: "Approve the deploy window",
      visibility: "public",
    });
    // The viewer cannot see another person's private item, and a public
    // item assigned only to another person is not in the viewer's Inbox.
    await inboxItem({
      assigneeUserIds: [other.id],
      nowMs: 5_000,
      title: "Deploy the private fix",
    });
    await inboxItem({
      assigneeUserIds: [other.id],
      nowMs: 5_000,
      title: "Deploy the public fix",
      visibility: "public",
    });
    // A body match ranks below title matches.
    const bodyMatch = await inboxItem({
      assigneeUserIds: [viewer.id],
      body: "Deploy it.",
      nowMs: 6_000,
      title: "Rotate the token",
    });
    const search = signedIn(viewer);

    const found = await report(
      expectSqlBudget(() => search("deplo", "inboxItems"), {
        statements: 1,
        serialRounds: 1,
      }),
    );

    // Open items first, each best match first: title matches, newest
    // first, then the body match.
    expect(found).toEqual({
      inboxItems: [
        expect.objectContaining({ title: "Deployment of payments-v42" }),
        expect.objectContaining({ title: "Review the deploy freeze" }),
        expect.objectContaining({ title: "Approve the deploy window" }),
        { id: bodyMatch.id, status: "open", title: "Rotate the token" },
        { id: closed.id, status: "done", title: "Deploy the docs" },
      ],
    });
    expect(
      (await report(search("pay V4", "inboxItems"))).inboxItems?.map(
        (item) => item.title,
      ),
    ).toEqual(["Deployment of payments-v42"]);
    // A missing letter still finds the title, and ranks it first.
    expect(
      (await report(search("deploymnt", "inboxItems"))).inboxItems?.[0],
    ).toEqual(expect.objectContaining({ title: "Deployment of payments-v42" }));
    expect((await report(search("zebra", "inboxItems"))).inboxItems).toEqual(
      [],
    );
  });

  it("finds the Automations that the viewer owns or that are shared to them", async () => {
    const viewer = await person(VIEWER);
    const other = await person(OTHER);
    await automation({
      creator: viewer,
      id: "sched_viewer_digest",
      slackUserId: VIEWER.slackUserId,
      title: "Weekly digest",
      visibility: "private",
    });
    await automation({
      creator: other,
      id: "sched_other_public",
      slackUserId: OTHER.slackUserId,
      title: "Digest of weekend incidents",
      visibility: "public",
    });
    await automation({
      creator: other,
      id: "sched_other_private",
      slackUserId: OTHER.slackUserId,
      title: "Private digest",
      visibility: "private",
    });
    await automation({
      creator: viewer,
      id: "sched_viewer_deleted",
      slackUserId: VIEWER.slackUserId,
      status: "deleted",
      title: "Deleted digest",
      visibility: "private",
    });
    // An instruction match ranks below title matches.
    await automation({
      creator: viewer,
      id: "sched_viewer_triage",
      instruction: "Post the digest.",
      slackUserId: VIEWER.slackUserId,
      title: "Issue triage",
      visibility: "private",
    });
    // An untitled Automation shows the title that its list row shows.
    await automation({
      creator: viewer,
      id: "sched_viewer_untitled",
      instruction: "Summarize the digest threads.",
      slackUserId: VIEWER.slackUserId,
      visibility: "private",
    });
    const search = signedIn(viewer);
    const ids = async (q: string) =>
      (await report(search(q, "automations"))).automations?.map(
        (match) => match.id,
      );

    const found = await report(search("dig", "automations"));

    expect(found).toEqual({
      automations: [
        {
          id: "sched_other_public",
          kind: "scheduled",
          status: "active",
          title: "Digest of weekend incidents",
        },
        expect.objectContaining({ id: "sched_viewer_digest" }),
        expect.objectContaining({
          id: "sched_viewer_untitled",
          title: fallbackShortTitle(
            "Summarize the digest threads.",
            "Untitled scheduled automation",
          ),
        }),
        expect.objectContaining({ id: "sched_viewer_triage" }),
      ],
    });
    // A missing letter still finds the title.
    expect(await ids("wekly")).toEqual(["sched_viewer_digest"]);
    // A pasted dashboard URL finds its Automation by id.
    expect(
      await ids("https://junior.example.com/automations/sched_viewer_triage"),
    ).toEqual(["sched_viewer_triage"]);
  });

  it("finds only the active public memories that the Memories page shows", async () => {
    // A typed prefix gets a vector far from every memory, so words alone
    // match it.
    mockEmbeddings((text) =>
      text === "relea" ? UNRELATED_VECTOR : MEMORY_VECTOR,
    );
    const viewer = await person(VIEWER);
    const other = await person(OTHER);
    const pastMs = Date.now() - 60_000;
    await memory("memory-visible", "Release notes go in the changelog.");
    await memory("memory-private", "Release notes are private.", {
      scope: "private",
      scopeKey: viewer.id,
    });
    await memory("memory-other-user", "Release notes of another User.", {
      scope: "private",
      scopeKey: other.id,
    });
    await memory("memory-archived", "Release notes were archived.", {
      archiveReason: "user_removed",
      archivedAtMs: pastMs,
    });
    await memory("memory-superseded", "Release notes were replaced.", {
      supersededAtMs: pastMs,
      supersededById: "memory-visible",
    });
    await memory("memory-expired", "Release notes expired.", {
      expiresAtMs: pastMs,
    });
    const search = signedIn(viewer);
    const ids = async (q: string) =>
      (await report(search(q, "memories"))).memories?.map(({ id }) => id);

    // A half-typed word matches the words that it starts.
    expect(await ids("relea")).toEqual(["memory-visible"]);
    // Every stored vector is the query vector, so the vector leg alone
    // finds a memory with no matching word, and still hides the others.
    expect(await ids("zebra")).toEqual(["memory-visible"]);
  });

  it("finds To-dos only where the viewer sees the Conversation's private content, open ones first", async () => {
    const viewer = await person(VIEWER);
    await rootConversation({
      conversationId: "local:search:public",
      visibility: "public",
    });
    await rootConversation({
      conversationId: "local:search:mine",
      participantId: viewer.id,
      visibility: "private",
    });
    await getConversationStore().createChild({
      childConversationId: "local:search:mine-task",
      kind: "task",
      parentConversationId: "local:search:mine",
    });
    // The viewer sees only redacted To-dos here, at the root and in a child.
    await rootConversation({
      conversationId: "local:search:redacted",
      visibility: "private",
    });
    await getConversationStore().createChild({
      childConversationId: "local:search:redacted-task",
      kind: "task",
      parentConversationId: "local:search:redacted",
    });
    await todos("local:search:mine", [
      { status: "done", title: "Ship the hotfix" },
      { status: "in_progress", title: "Ship the documentation" },
    ]);
    await todos("local:search:mine-task", [
      { status: "dropped", title: "Ship the old plan" },
      { status: "open", title: "Ship the task summary" },
    ]);
    await todos("local:search:public", [
      { status: "open", title: "Ship the release notes" },
    ]);
    await todos("local:search:redacted", [
      { status: "open", title: "Ship the secret plan" },
    ]);
    await todos("local:search:redacted-task", [
      { status: "done", title: "Ship the secret task" },
    ]);
    const search = signedIn(viewer);
    const titles = async (q: string) =>
      (await report(search(q, "todos"))).todos?.map(({ title }) => title);

    // Open and in-progress To-dos first, newest first on equal matches, then
    // the closed ones.
    expect(await titles("shi")).toEqual([
      "Ship the release notes",
      "Ship the task summary",
      "Ship the documentation",
      "Ship the old plan",
      "Ship the hotfix",
    ]);
    expect(await titles("secret")).toEqual([]);
    // A typo in a title still matches.
    expect(await titles("documentaton")).toEqual(["Ship the documentation"]);
  });

  it("finds a memory by a half-typed inflected word", async () => {
    mockEmbeddings((text) =>
      text === "runn" ? UNRELATED_VECTOR : MEMORY_VECTOR,
    );
    const viewer = await person(VIEWER);
    await memory("memory-running", "Running the deploy checklist first.");
    const ids = async (q: string) =>
      (await report(signedIn(viewer)(q, "memories"))).memories?.map(
        ({ id }) => id,
      );

    // `english` stems "running" to "run", which "runn" does not start.
    expect(await ids("runn")).toEqual(["memory-running"]);
  });

  it("embeds typed text of 3 or more characters once, and records its cost", async () => {
    // 50 tokens of the default embedding model cost 1 micro-USD.
    const calls = mockEmbeddings(() => MEMORY_VECTOR, { tokensPerText: 50 });
    const viewer = await person(VIEWER);
    await memory("memory-release", "Release notes go in the changelog.");
    calls.length = 0;
    const search = signedIn(viewer);
    const ids = async (q: string) =>
      (await report(search(q, "memories"))).memories?.map(({ id }) => id);

    // Words alone match 2 characters.
    expect(await ids("re")).toEqual(["memory-release"]);
    expect(calls).toEqual([]);
    expect(await ids("release")).toEqual(["memory-release"]);
    expect(await ids("release")).toEqual(["memory-release"]);
    expect(calls).toEqual([["release"]]);
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await readStats(today, today)).filter(
        ({ namespace }) => namespace === "search",
      ),
    ).toEqual([
      {
        count: 1,
        date: today,
        metric: "embedding_cost_micro_usd",
        name: "openai/text-embedding-3-small",
        namespace: "search",
      },
    ]);
  });

  it("reads every source at once from its index, within a size budget", async () => {
    const viewer = await person(VIEWER);
    await inboxItem({
      assigneeUserIds: [viewer.id],
      nowMs: 1_000,
      title: `Deploy ${"x".repeat(INBOX_ITEM_TITLE_MAX_LENGTH - 7)}`,
    });
    await automation({
      creator: viewer,
      // As long as a stored id: `sched_` and 32 hex digits.
      id: `sched_${"0".repeat(32)}`,
      slackUserId: VIEWER.slackUserId,
      title: `Deploy ${"x".repeat(SHORT_TITLE_MAX_LENGTH - 7)}`,
      visibility: "private",
    });
    // The query embedding costs 1 micro-USD, so its cost is always recorded.
    mockEmbeddings(() => MEMORY_VECTOR, { tokensPerText: 50 });
    // As long as a stored id: a UUID.
    await memory(randomUUID(), `Deploy ${"x".repeat(1_000)}`);
    // As long as a stored id: an agent id.
    const budgetConversationId = `agent:${"0".repeat(32)}`;
    await rootConversation({
      conversationId: budgetConversationId,
      participantId: viewer.id,
      visibility: "private",
    });
    await todos(budgetConversationId, [
      {
        status: "open",
        title: `Deploy ${"x".repeat(TODO_TITLE_MAX_LENGTH - 7)}`,
      },
    ]);
    const search = signedIn(viewer);
    const sources = "inboxItems,automations,memories,todos";

    const response = await expectResponseBudget(
      () =>
        expectNoFullScan(() =>
          expectSqlBudget(() => search("deploy", sources), {
            statements: 7,
            serialRounds: 1,
          }),
        ),
      { automations: 155, inboxItems: 272, memories: 176, todos: 300 },
    );

    const found = await report(response);
    expect(found.automations).toHaveLength(1);
    expect(found.inboxItems).toHaveLength(1);
    expect(found.memories).toHaveLength(1);
    expect(found.todos).toHaveLength(1);
    // Text with no letters or digits matches nothing and reads nothing.
    const punctuation = await measureSql(() => search("&|!", sources));
    expect(punctuation.sql.statements).toBe(0);
    expect(await report(punctuation.result)).toEqual({
      automations: [],
      inboxItems: [],
      memories: [],
      todos: [],
    });
    expect((await search("deploy", "inboxItems,plans")).status).toBe(400);
  });

  it("finds a pull request's item by the pull request title, which the item does not store", async () => {
    // The GitHub plugin registers the `pull_request` kind, whose objects are
    // code changes.
    await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
    const viewer = await person(VIEWER);
    const change = (providerId: string, number: number, title: string) =>
      recordCodeChange(getDb(), "github", {
        conversationIds: [],
        number,
        openedAt: new Date(1_000),
        providerId,
        repository: { name: "getsentry/junior", providerId: "repository-1" },
        state: "open",
        title,
        updatedAt: new Date(1_000),
      });
    await change("1001", 946, "Make deploys resumable");
    await change("1002", 947, "Rotate the signing key");
    const pullRequestItem = async (id: string, number: number) => {
      // The opener's row names the Conversation that owns the item.
      await getDb().execute(
        sql`insert into junior_github_pull_request_requesters (repository_full_name, number, identity_id, conversation_id, pull_request_id, created_at, updated_at) values ('getsentry/junior', ${number}, 'identity:opener', 'slack:C123:owner', ${id}, now(), now())`,
      );
      return insertInboxItem(getDb(), {
        assignedToEveryone: false,
        assigneeUserIds: [viewer.id],
        body: `GitHub asks you to review #${number}.`,
        conversationIds: [],
        kind: "notice",
        nowMs: number,
        owner: { id: "slack:C123:owner", kind: "conversation" },
        subject: { id, kind: "github:pull_request" },
        title: `Review requested · #${number}`,
      });
    };
    const resumable = await pullRequestItem("1001", 946);
    await pullRequestItem("1002", 947);
    const search = signedIn(viewer);

    // One statement reads the item matches and the code change matches.
    const found = await report(
      expectNoFullScan(() =>
        expectSqlBudget(() => search("resumab", "inboxItems"), {
          statements: 1,
          serialRounds: 1,
        }),
      ),
    );
    expect(found).toEqual({
      inboxItems: [
        {
          id: resumable!.id,
          status: "open",
          title: "Review requested · #946",
        },
      ],
    });
    // The item's own text still matches.
    expect((await report(search("review", "inboxItems"))).inboxItems).toEqual([
      expect.objectContaining({ title: "Review requested · #947" }),
      expect.objectContaining({ title: "Review requested · #946" }),
    ]);
  });
});
