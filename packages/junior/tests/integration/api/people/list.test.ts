import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { actorDirectoryReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { seedPeople } from "./fixture";

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
      await store.recordActivity({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
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
        actor: {
          email: "bob@example.com",
          fullName: "Bob Example",
          platform: "slack",
          slackUserId: "U2",
          teamId: "T1",
        },
        conversationId: "slack:C2:shared-day",
        destination: {
          channelId: "C2",
          platform: "slack",
          teamId: "T1",
        },
        nowMs: Date.parse("2026-06-12T12:30:00.000Z"),
        source: "slack",
      });

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
});
