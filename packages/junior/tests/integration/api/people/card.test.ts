import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import type { JuniorApiEnv } from "@/api/route";
import { personCardReportSchema } from "@/api/schema";
import { setDashboardConversationLinkOptions } from "@/chat/dashboard-link";
import { recordCodeChange } from "@/chat/code/store";
import {
  closeDb,
  getConversationStore,
  getDb,
  getSqlExecutor,
} from "@/chat/db";
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

// A pull request from one of Ana's Conversations.
async function anaChange(args: {
  mergedAtMs?: number;
  number: number;
  openedAtMs: number;
}) {
  await recordCodeChange(getDb(), "github", {
    conversationIds: ["slack:CPUB:1.000001"],
    ...(args.mergedAtMs ? { mergedAt: new Date(args.mergedAtMs) } : undefined),
    number: args.number,
    openedAt: new Date(args.openedAtMs),
    providerId: `change-${args.number}`,
    repository: {
      name: "getsentry/junior",
      providerId: "repository-1",
      url: "https://github.com/getsentry/junior",
    },
    state: args.mergedAtMs ? "merged" : "open",
    title: `Change ${args.number}`,
    updatedAt: new Date(args.mergedAtMs ?? args.openedAtMs),
    url: `https://github.com/getsentry/junior/pull/${args.number}`,
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
    await anaTurn({
      atMs: now - 10 * 24 * HOUR_MS,
      conversationId: "slack:CPUB:1.000003",
      runId: "old-1",
      title: "Fix the old bug",
      visibility: "public",
    });
    // Four merged pull requests and an open one: the card lists the three
    // newest merges.
    for (const [number, mergedHoursAgo] of [
      [11, 30],
      [12, 3],
      [13, 20],
      [14, 5],
    ] as const) {
      await anaChange({
        mergedAtMs: now - mergedHoursAgo * HOUR_MS,
        number,
        openedAtMs: now - 40 * HOUR_MS,
      });
    }
    await anaChange({ number: 15, openedAtMs: now - HOUR_MS });

    const bob = await cardApi("bob@example.com");
    // The card reads the User in two steps after a cache read, while the
    // recent Conversations, their access, and the merged changes run beside
    // it. The User reads can start after the first activity read ends.
    const card = await expectSqlBudget(() => bob("Ana@Example.com"), {
      statements: 6,
      serialRounds: 4,
    });
    expect(
      card.mergedChanges.map(
        ({ mergedAt, number, repository, title, url }) => ({
          mergedAt,
          number,
          repository,
          title,
          url,
        }),
      ),
    ).toEqual(
      (
        [
          [12, 3],
          [14, 5],
          [13, 20],
        ] as const
      ).map(([number, mergedHoursAgo]) => ({
        mergedAt: new Date(now - mergedHoursAgo * HOUR_MS).toISOString(),
        number,
        repository: "getsentry/junior",
        title: `Change ${number}`,
        url: `https://github.com/getsentry/junior/pull/${number}`,
      })),
    );
    const { mergedChanges: _mergedChanges, ...rest } = card;
    expect(rest).toEqual({
      activity: {
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
      activity: { recentConversations: [] },
      mergedChanges: [],
    });
  });
});
