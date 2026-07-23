import { describe, expect, test, vi } from "vitest";
import {
  readLocationDetailFromSql,
  readLocationDirectoryFromSql,
} from "@/api/locations/query";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../fixtures/sql";

describe("locations API", () => {
  test("aggregates every location conversation and bounds only recent rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);

    try {
      await migrateSchema(fixture.sql);
      const nowMs = Date.parse("2026-06-15T11:00:00.000Z");
      await store.recordActivity({
        conversationId: "slack:C1:seed",
        channelName: "proj-alpha",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        source: "slack",
        visibility: "public",
        nowMs,
      });
      const [destination] = await fixture.sql
        .db()
        .select()
        .from(juniorDestinations);
      expect(destination).toBeDefined();

      const now = new Date(nowMs);
      const aggregateNow = new Date(nowMs - 1_000);
      const aggregateConversations = Array.from({ length: 5_000 }, (_, index) =>
        buildJuniorSqlConversation({
          conversationId: `slack:C1:aggregate:${index}`,
          destinationId: destination?.id,
          durationMs: 2,
          createdAt: aggregateNow,
          lastActivityAt: aggregateNow,
          updatedAt: aggregateNow,
          usage: { totalTokens: 3 },
        }),
      );
      for (
        let index = 0;
        index < aggregateConversations.length;
        index += 1_000
      ) {
        await fixture.sql
          .db()
          .insert(juniorConversations)
          .values(aggregateConversations.slice(index, index + 1_000));
      }
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values(
          buildJuniorSqlConversation({
            conversationId: "internal:private",
            destination: null,
            destinationId: null,
            source: "internal",
            createdAt: now,
            lastActivityAt: now,
            updatedAt: now,
          }),
        );
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values(
          buildJuniorSqlConversation({
            conversationId: "child:location-usage",
            parentConversationId: "slack:C1:seed",
            rootConversationId: "slack:C1:seed",
            durationMs: 4,
            usage: { totalTokens: 7 },
            createdAt: now,
            lastActivityAt: now,
            updatedAt: now,
          }),
        );

      const directory = await readLocationDirectoryFromSql();
      expect(directory.locations).toHaveLength(1);
      expect(directory.locations[0]).toMatchObject({
        conversations: 5_001,
        durationMs: 10_004,
        label: "#proj-alpha",
        tokens: 15_007,
      });
      expect(directory.privateActivity.conversations).toBe(1);
      expect(directory.activityDays).toHaveLength(90);
      expect(
        directory.activityDays.find((day) => day.date === "2026-06-15"),
      ).toEqual({
        date: "2026-06-15",
        privateConversations: 1,
        publicConversations: 5_001,
      });
      expect(directory.windowStart).toBe("2026-03-18T00:00:00.000Z");
      expect(directory.windowEnd).toBe("2026-06-15T00:00:00.000Z");

      const detail = await readLocationDetailFromSql(destination?.id ?? "");
      expect(detail).toMatchObject({
        conversations: 5_001,
        durationMs: 10_004,
        tokens: 15_007,
      });
      expect(detail?.recentConversations).toHaveLength(25);
      expect(detail?.recentConversations[0]).toMatchObject({
        conversationId: "slack:C1:seed",
        cumulativeDurationMs: 4,
        cumulativeUsage: { totalTokens: 7 },
      });
      expect(detail?.activityDays).toHaveLength(90);
      expect(
        detail?.activityDays.find((day) => day.date === "2026-06-15"),
      ).toMatchObject({
        conversations: 5_001,
        durationMs: 10_004,
        tokens: 15_007,
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
