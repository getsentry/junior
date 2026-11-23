import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { searchReportSchema } from "@/api/schema";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { closeDb, getDb, getSqlExecutor } from "@/chat/db";
import { closeInboxItem, insertInboxItem } from "@/chat/inbox-items/store";
import { reembedMemories } from "@/chat/memory/reembed";
import { memoryDb } from "@/chat/memory/store";
import { createPluginEmbedder } from "@/chat/plugins/model";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { saveScheduledAutomation } from "@/chat/scheduled-automations/tasks";
import {
  fallbackShortTitle,
  SHORT_TITLE_MAX_LENGTH,
} from "@/chat/services/short-title";
import { juniorMemoryMemories } from "@/db/schema/memory";
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
  const item = await insertInboxItem(getDb(), {
    assignedToEveryone: false,
    assigneeUserIds: args.assigneeUserIds ?? [],
    body: args.body ?? "",
    conversationIds: [],
    dedupeKey: args.title,
    kind: "notice",
    nowMs: args.nowMs,
    owner: { id: "slack:C123:owner", kind: "conversation" },
    ...(visibility === "public"
      ? { tenant: { provider: "slack", providerTenantId: TEAM_ID } }
      : undefined),
    title: args.title,
    visibility,
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
    mockEmbeddings(() => MEMORY_VECTOR);
    // As long as a stored id: a UUID.
    await memory(randomUUID(), `Deploy ${"x".repeat(1_000)}`);
    const search = signedIn(viewer);
    const sources = "inboxItems,automations,memories";

    const response = await expectResponseBudget(
      () =>
        expectNoFullScan(() =>
          expectSqlBudget(() => search("deploy", sources), {
            statements: 4,
            serialRounds: 1,
          }),
        ),
      { automations: 155, inboxItems: 272, memories: 176 },
    );

    const found = await report(response);
    expect(found.automations).toHaveLength(1);
    expect(found.inboxItems).toHaveLength(1);
    expect(found.memories).toHaveLength(1);
    // Text with no letters or digits matches nothing and reads nothing.
    const punctuation = await measureSql(() => search("&|!", sources));
    expect(punctuation.sql.statements).toBe(0);
    expect(await report(punctuation.result)).toEqual({
      automations: [],
      inboxItems: [],
      memories: [],
    });
    expect((await search("deploy", "inboxItems,todos")).status).toBe(400);
  });
});
