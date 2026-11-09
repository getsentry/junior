import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { actorDirectoryReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { readPersonalSpendFromSql } from "@/api/people/spend.query";
import { recordTurn, seedPeople, turnActorIdentityId } from "./fixture";

describe("people list API", () => {
  test("serves the route through its response schema", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const response = await createJuniorApi().request(
        "http://localhost/api/people",
      );
      expect(response.status).toBe(200);
      actorDirectoryReportSchema.parse(await response.json());
    } finally {
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
      for (const [conversationId, actor, at] of [
        ["slack:C1:duplicate-day", aliceActor, "2026-06-12T12:00:00.000Z"],
        ["slack:C2:shared-day", bobActor, "2026-06-12T12:30:00.000Z"],
      ] as const) {
        await recordTurn(fixture, {
          actor,
          atMs: Date.parse(at),
          conversationId,
          runId: `turn-${conversationId}`,
        });
      }

      const report = await readPeopleListFromSql();

      expect(report.people.map((person) => person.actor.email)).toEqual([
        "bob@example.com",
        "alice@example.com",
        "later@example.com",
      ]);
      const alice = report.people.find(
        (person) => person.actor.email === "alice@example.com",
      );
      expect(alice).toMatchObject({
        active: 1,
        activeDays: 2,
        conversations: 3,
        durationMs: 1_500,
        failed: 1,
        tokens: 150,
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
        conversations: 1,
        durationMs: 1_000,
        windows: { 7: { conversations: 1, costUsd: 0.1 } },
      });
      // Ben did not start the Conversation, but his Turn counts it for him.
      expect(person("ben@example.com")).toMatchObject({
        actor: { fullName: "Ben Example" },
        conversations: 1,
        durationMs: 1_000,
        lastSeenAt: "2026-06-14T11:00:00.000Z",
        windows: { 7: { conversations: 1, costUsd: 0.3 } },
      });
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
