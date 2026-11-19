import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { readPeopleProfileFromSql } from "@/api/people/profile.query";
import { actorDirectoryReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import {
  expectNoFullScan,
  expectSqlBudget,
  measureSql,
} from "../../../fixtures/sql-budget";
import { createWaitUntilCollector } from "../../../fixtures/wait-until";
import { readPersonalSpendFromSql } from "@/api/people/spend.query";
import { recordTurn, seedPeople, turnActorIdentityId } from "./fixture";

describe("people list API", () => {
  test("serves a cached list and refreshes it once when stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const background = createWaitUntilCollector();
    const api = createJuniorApi({ waitUntil: background.fn });
    const readPeople = async () => {
      const response = await api.request("http://localhost/api/people");
      expect(response.status).toBe(200);
      return actorDirectoryReportSchema.parse(await response.json());
    };

    try {
      await migrateSchema(fixture.sql);
      const uncached = await measureSql(readPeople);
      expect(uncached.sql.statements).toBe(5);
      const first = uncached.result;
      expect(first.people).toEqual([]);

      await seedPeople(fixture);
      vi.setSystemTime(new Date("2026-06-15T12:04:00.000Z"));
      const fresh = await measureSql(readPeople);
      expect(fresh.sql.statements).toBe(0);
      expect(fresh.result).toEqual(first);
      expect(background.pendingCount()).toBe(0);

      // A stale list is served at once. Concurrent requests start one
      // refresh between them.
      vi.setSystemTime(new Date("2026-06-15T12:06:00.000Z"));
      const stale = await measureSql(async () => {
        const reports = await Promise.all([readPeople(), readPeople()]);
        expect(background.pendingCount()).toBe(2);
        await background.flush();
        return reports;
      });
      expect(stale.result).toEqual([first, first]);
      expect(stale.sql.statements).toBe(5);

      const refreshed = await readPeople();
      expect(refreshed.people.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("lists people by shared verified actor identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await seedPeople(fixture);
      const store = createSqlStore(fixture.sql);
      const aliceActor = {
        email: "alice@example.com",
        fullName: "Alice Example",
        platform: "slack",
        slackUserId: "U1",
        teamId: "T1",
      } as const;
      const bobActor = {
        email: "bob@example.com",
        fullName: "Bob Example",
        platform: "slack",
        slackUserId: "U2",
        teamId: "T1",
      } as const;
      await store.recordActivity({
        actor: aliceActor,
        conversationId: "slack:C1:duplicate-day",
        destination: {
          channelId: "C1",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-06-12T12:00:00.000Z"),
        source: "slack",
      });
      await store.recordActivity({
        actor: bobActor,
        conversationId: "slack:C2:shared-day",
        destination: {
          channelId: "C2",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-06-12T12:30:00.000Z"),
        source: "slack",
      });
      // Dana's last Turn is older than every range.
      const danaActor = {
        email: "dana@example.com",
        fullName: "Dana Example",
        platform: "slack",
        slackUserId: "UDANA",
        teamId: "T1",
      } as const;
      await store.recordActivity({
        actor: danaActor,
        conversationId: "slack:C3:dormant",
        destination: {
          channelId: "C3",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-01-05T09:00:00.000Z"),
        source: "slack",
      });
      for (const [conversationId, actor, at] of [
        ["slack:C1:duplicate-day", aliceActor, "2026-06-12T12:00:00.000Z"],
        ["slack:C2:shared-day", bobActor, "2026-06-12T12:30:00.000Z"],
        ["slack:C3:dormant", danaActor, "2026-01-05T09:00:00.000Z"],
        ["slack:C3:dormant", danaActor, "2026-02-20T09:00:00.000Z"],
      ] as const) {
        await recordTurn(fixture, {
          actor,
          atMs: Date.parse(at),
          conversationId,
          runId: `turn-${conversationId}-${at}`,
        });
      }

      // One round of bounded reads, whatever the history length. Each read
      // of the metrics table uses an index.
      const report = await expectNoFullScan(
        () =>
          expectSqlBudget(() => readPeopleListFromSql(), {
            statements: 5,
            serialRounds: 1,
          }),
        ["junior_conversation_metrics"],
      );

      expect(report.people.map((person) => person.actor.email)).toEqual([
        "bob@example.com",
        "alice@example.com",
        "later@example.com",
        "dana@example.com",
      ]);
      const alice = report.people.find(
        (person) => person.actor.email === "alice@example.com",
      );
      expect(alice).toMatchObject({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
        },
      });
      expect(alice?.windows[90]).toMatchObject({
        conversations: 3,
        costUsd: 0.42,
        durationMs: 1_500,
        priorCostUsd: 0,
      });
      expect(alice?.windows[7]).toMatchObject({
        conversations: 3,
        costUsd: 0.42,
        durationMs: 1_500,
      });
      expect(alice?.windows[1]).toMatchObject({
        conversations: 0,
        costUsd: 0,
        durationMs: 0,
        priorCostUsd: 0,
      });
      // The list keeps a person with no Turn in any range, with their
      // all-time Turn range.
      expect(
        report.people.find(
          (person) => person.actor.email === "dana@example.com",
        ),
      ).toEqual({
        actor: {
          email: "dana@example.com",
          fullName: "Dana Example",
          slackUserId: "UDANA",
        },
        firstSeenAt: "2026-01-05T09:00:00.000Z",
        lastSeenAt: "2026-02-20T09:00:00.000Z",
        windows: Object.fromEntries(
          [1, 7, 30, 90].map((range) => [
            range,
            { conversations: 0, costUsd: 0, durationMs: 0, priorCostUsd: 0 },
          ]),
        ),
      });
      expect(
        report.people.some(
          (person) => person.actor.email === "untrusted@example.com",
        ),
      ).toBe(false);
      expect(report.activityDays).toHaveLength(90);
      expect(report.activityHours).toHaveLength(7 * 24);
      expect(report.activitySixHours).toHaveLength(7 * 4);
      expect(
        report.activityDays.find((day) => day.date === "2026-06-12"),
      ).toEqual({
        activePeople: 2,
        conversations: 3,
        date: "2026-06-12",
      });
      expect(report.windowStart).toBe("2026-03-18T00:00:00.000Z");
      expect(report.windowEnd).toBe("2026-06-15T00:00:00.000Z");
      expect(report.source).toBe("conversation_index");
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("attributes Turn spend to the Turn Actor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const store = createSqlStore(fixture.sql);
      const ana = {
        email: "ana@example.com",
        fullName: "Ana Example",
        platform: "slack",
        slackUserId: "UANA",
        teamId: "T1",
      } as const;
      const ben = {
        email: "ben@example.com",
        fullName: "Ben Example",
        platform: "slack",
        slackUserId: "UBEN",
        teamId: "T1",
      } as const;
      const conversationId = "slack:C1:shared";
      // Ana starts the Conversation. Ben runs a later Turn in it.
      await store.recordActivity({
        actor: ana,
        conversationId,
        destination: { channelId: "C1", platform: "slack", teamId: "T1" },
        nowMs: Date.parse("2026-06-14T10:00:00.000Z"),
        source: "slack",
      });
      for (const [turnId, actor, costUsd, atMs] of [
        ["ana-turn", ana, 0.1, Date.parse("2026-06-14T10:00:00.000Z")],
        ["ben-turn", ben, 0.3, Date.parse("2026-06-14T11:00:00.000Z")],
      ] as const) {
        await store.recordExecution({
          actorIdentityId: await turnActorIdentityId(fixture, actor),
          conversationId,
          createdAtMs: atMs,
          execution: { runId: turnId, status: "idle", updatedAtMs: atMs },
          lastActivityAtMs: atMs,
          metrics: { durationMs: 1_000, usage: { cost: { total: costUsd } } },
          updatedAtMs: atMs,
        });
      }

      const report = await readPeopleListFromSql();
      const person = (email: string) =>
        report.people.find((entry) => entry.actor.email === email);
      expect(person("ana@example.com")).toMatchObject({
        windows: { 7: { conversations: 1, costUsd: 0.1, durationMs: 1_000 } },
      });
      // Ben did not start the Conversation, but his Turn counts it for him.
      expect(person("ben@example.com")).toMatchObject({
        actor: { fullName: "Ben Example" },
        lastSeenAt: "2026-06-14T11:00:00.000Z",
        windows: { 7: { conversations: 1, costUsd: 0.3, durationMs: 1_000 } },
      });
      // Ana ran two Turns on two days in her own Conversation. It failed.
      for (const [turnId, at, status] of [
        ["ana-own-1", "2026-06-13T10:00:00.000Z", "idle"],
        ["ana-own-2", "2026-06-14T10:30:00.000Z", "failed"],
      ] as const) {
        await store.recordExecution({
          actorIdentityId: await turnActorIdentityId(fixture, ana),
          conversationId: "slack:C1:ana-own",
          createdAtMs: Date.parse(at),
          destination: { channelId: "C1", platform: "slack", teamId: "T1" },
          execution: { runId: turnId, status, updatedAtMs: Date.parse(at) },
          lastActivityAtMs: Date.parse(at),
          metrics: { durationMs: 0 },
          updatedAtMs: Date.parse(at),
        });
      }
      const profile = await readPeopleProfileFromSql("ana@example.com");
      // Recent order follows Ana's own last Turn, not Ben's later activity.
      expect(
        profile.recentConversations.map((item) => item.conversationId),
      ).toEqual(["slack:C1:ana-own", conversationId]);
      // The failure counts once, on the day of her last Turn in it.
      const day = (date: string) =>
        profile.activityDays.find((entry) => entry.date === date);
      expect(day("2026-06-13")).toMatchObject({ conversations: 1, failed: 0 });
      expect(day("2026-06-14")).toMatchObject({ conversations: 2, failed: 1 });
      expect(profile.totals).toMatchObject({ conversations: 2, failed: 1 });

      const nowMs = Date.now();
      expect(
        await readPersonalSpendFromSql("ana@example.com", nowMs),
      ).toMatchObject({ thirtyDaysUsd: 0.1 });
      expect(
        await readPersonalSpendFromSql("ben@example.com", nowMs),
      ).toMatchObject({ thirtyDaysUsd: 0.3 });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
