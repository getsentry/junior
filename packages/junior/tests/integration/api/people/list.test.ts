import { describe, expect, test, vi } from "vitest";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { seedPeople } from "./fixture";

describe("people list API", () => {
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
      expect(
        report.people.find(
          (person) => person.actor.email === "alice@example.com",
        ),
      ).toMatchObject({
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
      expect(
        report.people.some(
          (person) => person.actor.email === "untrusted@example.com",
        ),
      ).toBe(false);
      expect(report.activityDays).toHaveLength(90);
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
