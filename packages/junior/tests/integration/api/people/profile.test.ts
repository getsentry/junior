import { describe, expect, test, vi } from "vitest";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { readPeopleProfileFromSql } from "@/api/people/profile.query";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations, juniorIdentities } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../../fixtures/sql";
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
      expect(report.activityDays).toHaveLength(365);
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

  test("aggregates every actor conversation and bounds only recent rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      const nowMs = Date.parse("2026-06-15T11:00:00.000Z");
      await store.recordActivity({
        conversationId: "slack:C1:seed",
        actor: {
          email: "aggregate@example.com",
          fullName: "Aggregate Example",
          platform: "slack",
          slackUserId: "U-aggregate",
          teamId: "T1",
        },
        source: "slack",
        nowMs,
      });
      const [identity] = await fixture.sql.db().select().from(juniorIdentities);
      expect(identity).toBeDefined();

      const now = new Date(nowMs);
      const conversations = Array.from({ length: 5_000 }, (_, index) =>
        buildJuniorSqlConversation({
          actorIdentityId: identity?.id,
          conversationId: `slack:C1:aggregate:${index}`,
          destination: null,
          destinationId: null,
          durationMs: 2,
          createdAt: now,
          lastActivityAt: now,
          updatedAt: now,
          usage: { totalTokens: 3 },
        }),
      );
      for (let offset = 0; offset < conversations.length; offset += 500) {
        await fixture.sql
          .db()
          .insert(juniorConversations)
          .values(conversations.slice(offset, offset + 500));
      }

      const report = await readPeopleProfileFromSql("aggregate@example.com");
      expect(report.totals).toMatchObject({
        conversations: 5_001,
        durationMs: 10_000,
        tokens: 15_000,
      });
      expect(report.recentConversations).toHaveLength(25);
      expect(
        report.activityDays.find((day) => day.date === "2026-06-15"),
      ).toMatchObject({
        conversations: 5_001,
        durationMs: 10_000,
        tokens: 15_000,
      });
      const directory = await readPeopleListFromSql();
      expect(directory.people).toEqual([
        expect.objectContaining({
          conversations: 5_001,
          durationMs: 10_000,
          tokens: 15_000,
          actor: expect.objectContaining({
            email: "aggregate@example.com",
          }),
        }),
      ]);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
