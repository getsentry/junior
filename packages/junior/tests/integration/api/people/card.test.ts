import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { personCardReportSchema } from "@/api/schema";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { closeDb, getConversationStore, getSqlExecutor } from "@/chat/db";
import { resolveActorIdentityId } from "@/chat/identities/actor";
import { expectSqlBudget, measureSql } from "../../../fixtures/sql-budget";
import { signedInViewer } from "../../../fixtures/user";

const DASHBOARD = "https://junior.example.com";
const HOUR_MS = 60 * 60 * 1000;

const ana = {
  email: "ana@example.com",
  fullName: "Ana Example",
  platform: "slack",
  slackUserId: "UANA",
  slackUserName: "ana",
  teamId: "T123",
} as const;

async function anaTurn(args: {
  atMs: number;
  conversationId: string;
  runId: string;
  title: string;
  visibility: "private" | "public";
}) {
  const channelId = args.conversationId.split(":")[1]!;
  await getConversationStore().recordActivity({
    actor: ana,
    conversationId: args.conversationId,
    destination: { channelId, platform: "slack", teamId: "T123" },
    nowMs: args.atMs,
    source: "slack",
    title: args.title,
    visibility: args.visibility,
  });
  await getConversationStore().recordExecution({
    actorIdentityId: await resolveActorIdentityId(getSqlExecutor(), {
      email: ana.email,
      fullName: ana.fullName,
      platform: "slack",
      teamId: ana.teamId,
      userId: ana.slackUserId,
    }),
    conversationId: args.conversationId,
    createdAtMs: args.atMs,
    execution: { runId: args.runId, status: "idle", updatedAtMs: args.atMs },
    lastActivityAtMs: args.atMs,
    metrics: { durationMs: 1_000 },
    updatedAtMs: args.atMs,
  });
}

async function cardApi(email: string) {
  const viewer = await signedInViewer(email);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return async (person: string) => {
    const response = await app.request(
      `http://localhost/api/people/${encodeURIComponent(person)}/card`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    return personCardReportSchema.parse(await response.json());
  };
}

describe("person card API", () => {
  let previousDashboard: ReturnType<typeof setDashboardConversationLinkOptions>;

  beforeEach(() => {
    previousDashboard = setDashboardConversationLinkOptions({
      baseURL: DASHBOARD,
    });
  });

  afterEach(async () => {
    setDashboardConversationLinkOptions(previousDashboard);
    await closeDb();
  });

  it("shows a person and the recent activity that the viewer may read", async () => {
    const now = Date.now();
    await anaTurn({
      atMs: now - 2 * HOUR_MS,
      conversationId: "slack:CPUB:1.000001",
      runId: "public-1",
      title: "Plan the launch",
      visibility: "public",
    });
    await anaTurn({
      atMs: now - HOUR_MS,
      conversationId: "slack:CPUB:1.000001",
      runId: "public-2",
      title: "Plan the launch",
      visibility: "public",
    });
    await anaTurn({
      atMs: now - HOUR_MS / 2,
      conversationId: "slack:GPRIV:1.000002",
      runId: "private-1",
      title: "Plan the reorg",
      visibility: "private",
    });
    // Older than a week: it is recent, but not in the counts.
    await anaTurn({
      atMs: now - 10 * 24 * HOUR_MS,
      conversationId: "slack:CPUB:1.000003",
      runId: "old-1",
      title: "Fix the old bug",
      visibility: "public",
    });

    const bob = await cardApi("bob@example.com");
    const card = await expectSqlBudget(() => bob("Ana@Example.com"), {
      statements: 6,
      serialRounds: 3,
    });
    expect(card).toEqual({
      activity: {
        conversations: 2,
        lastActiveAt: new Date(now - HOUR_MS / 2).toISOString(),
        // Bob does not take part in the private Conversation, so it never
        // shows.
        recentConversations: [
          {
            conversationId: "slack:CPUB:1.000001",
            lastTurnAt: new Date(now - HOUR_MS).toISOString(),
            title: "Plan the launch",
          },
          {
            conversationId: "slack:CPUB:1.000003",
            lastTurnAt: new Date(now - 10 * 24 * HOUR_MS).toISOString(),
            title: "Fix the old bug",
          },
        ],
        turns: 3,
      },
      // The same card as a link to Ana's People page.
      card: {
        facts: { email: "ana@example.com", slackHandle: "ana", type: "person" },
        key: "ana@example.com",
        kind: "object",
        label: "Ana Example",
        objectType: "person",
        plugin: "junior",
        title: "Ana Example",
        url: `${DASHBOARD}/people/${encodeURIComponent("ana@example.com")}`,
      },
    });
    expect(JSON.stringify(card)).not.toContain("Plan the reorg");
    // The same viewer reads the same person from the cache.
    expect((await measureSql(() => bob("ana@example.com"))).sql).toEqual({
      serialRounds: 0,
      statements: 0,
    });

    // Ana takes part in the private Conversation, so her card shows it.
    const own = await (await cardApi("ana@example.com"))("ana@example.com");
    expect(own.activity.recentConversations.map((item) => item.title)).toEqual([
      "Plan the reorg",
      "Plan the launch",
      "Fix the old bug",
    ]);
  });

  it("shows no activity for a person Junior does not know", async () => {
    const card = await (await cardApi("bob@example.com"))("nobody@example.com");
    expect(card).toEqual({
      activity: {
        conversations: 0,
        recentConversations: [],
        turns: 0,
      },
    });
  });
});
