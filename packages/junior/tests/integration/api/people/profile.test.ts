import { describe, expect, test, vi } from "vitest";
import { readPeopleProfileFromSql } from "@/api/people/profile.query";
import { createConfiguredJuniorSqlFixture } from "../../../fixtures/sql";
import { seedDisplayNameBackfill, seedPeople } from "./fixture";

describe("people profile API", () => {
  test("reads profiles case-insensitively from shared verified identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await seedPeople(fixture);

      const report = await readPeopleProfileFromSql("ALICE@example.com");

      expect(report).toMatchObject({
        actor: {
          email: "alice@example.com",
          fullName: "Alice Example",
        },
        totals: {
          active: 1,
          activeDays: 2,
          conversations: 2,
          durationMs: 1_500,
          failed: 1,
          tokens: 150,
        },
        locations: [
          expect.objectContaining({
            conversations: 1,
            durationMs: 1_000,
            label: "#proj-alpha",
            tokens: 100,
          }),
          expect.objectContaining({
            conversations: 1,
            durationMs: 500,
            failed: 1,
            label: "Private Conversation",
            tokens: 50,
          }),
        ],
      });
      expect(report.activityDays).toHaveLength(366);
      expect(
        report.activityDays.find((day) => day.date === "2026-06-12"),
      ).toMatchObject({
        conversations: 1,
        durationMs: 500,
        failed: 1,
        tokens: 50,
      });
      expect(
        report.recentConversations.map((item) => item.conversationId),
      ).toEqual(["slack:C4:456", "slack:C1:123"]);
      expect(report.recentConversations.map((item) => item.status)).toEqual([
        "failed",
        "active",
      ]);
      expect(report.recentConversations[0]).toMatchObject({
        channelName: "Private Conversation",
        channelNameRedacted: true,
        displayTitle: "Private Conversation",
      });
      expect(report.recentConversations[1]).toMatchObject({
        conversationId: "slack:C1:123",
        locationId: expect.any(String),
      });

      const untrusted = await readPeopleProfileFromSql("untrusted@example.com");
      expect(untrusted).toMatchObject({
        actor: {
          email: "untrusted@example.com",
        },
        totals: {
          conversations: 0,
        },
      });

      const blank = await readPeopleProfileFromSql("  ");
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
      const backfilled = await readPeopleProfileFromSql("nameless@example.com");
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
