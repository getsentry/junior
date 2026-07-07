import { describe, expect, test, vi } from "vitest";
import { readPeopleProfileFromSql } from "@/api/people/profile.query";
import { createLocalJuniorSqlFixture } from "../../../fixtures/sql";
import { seedDisplayNameBackfill, seedPeople } from "./fixture";

describe("people profile API", () => {
  test("reads profiles case-insensitively from shared verified identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = await createLocalJuniorSqlFixture();

    try {
      await seedPeople(fixture);

      const report = await readPeopleProfileFromSql("ALICE@example.com", {
        db: fixture.sql.db(),
      });

      expect(report).toMatchObject({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
        },
        totals: {
          active: 0,
          activeDays: 2,
          conversations: 2,
          failed: 1,
          runs: 2,
        },
        locations: [
          expect.objectContaining({
            conversations: 1,
            label: "#proj-alpha",
          }),
          expect.objectContaining({
            conversations: 1,
            failed: 1,
            label: "Private Conversation",
          }),
        ],
      });
      expect(report.activityDays).toHaveLength(366);
      expect(
        report.activityDays.find((day) => day.date === "2026-06-12"),
      ).toMatchObject({
        conversations: 1,
        failed: 1,
      });
      expect(
        report.recentConversations.map((item) => item.conversationId),
      ).toEqual(["slack:C4:456", "slack:C1:123"]);
      expect(report.recentConversations.map((item) => item.status)).toEqual([
        "failed",
        "completed",
      ]);

      const untrusted = await readPeopleProfileFromSql(
        "untrusted@example.com",
        {
          db: fixture.sql.db(),
        },
      );
      expect(untrusted).toMatchObject({
        actor: {
          email: "untrusted@example.com",
        },
        totals: {
          conversations: 0,
        },
      });

      const blank = await readPeopleProfileFromSql("  ", {
        db: fixture.sql.db(),
      });
      expect(blank).toMatchObject({
        actor: {
          email: "",
        },
        sampleSize: 0,
        totals: {
          conversations: 0,
        },
      });

      await seedDisplayNameBackfill(fixture);
      const backfilled = await readPeopleProfileFromSql(
        "nameless@example.com",
        {
          db: fixture.sql.db(),
        },
      );
      expect(backfilled).toMatchObject({
        actor: {
          email: "nameless@example.com",
          fullName: "Named Later",
        },
        totals: {
          conversations: 2,
        },
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
