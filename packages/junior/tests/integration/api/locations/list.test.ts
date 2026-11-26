import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readLocationDirectoryFromSql } from "@/api/locations/query";
import { locationDirectoryReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations, juniorDestinations } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
  type JuniorSqlConversationInsert,
} from "../../../fixtures/sql";
import {
  recordTurnFailure,
  recordTurnStart,
} from "../../../fixtures/turn-start";

describe("locations API", () => {
  test("serves the route through its response schema", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const response = await createJuniorApi().request(
        "http://localhost/api/locations",
      );
      expect(response.status).toBe(200);
      locationDirectoryReportSchema.parse(await response.json());
    } finally {
      await fixture.close();
    }
  });

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
      // Each dashboard Conversation has its own local destination. Public
      // ones report as one Dashboard location; private ones stay private.
      for (const [conversationId, visibility] of [
        ["local:web:public-a", "public"],
        ["local:web:public-b", "public"],
        ["local:web:private", "private"],
      ] as const) {
        await store.recordActivity({
          conversationId,
          destination: { platform: "local", conversationId },
          source: "web",
          visibility,
          nowMs,
        });
      }

      const now = new Date(nowMs);
      const aggregateNow = new Date(nowMs - 1_000);
      const aggregateConversations = Array.from({ length: 5_000 }, (_, index) =>
        buildJuniorSqlConversation({
          conversationId: `slack:C1:aggregate:${index}`,
          destinationId: destination?.id,
          visibility: "public",
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
      // A root keeps the visibility it was created with, so a private root
      // at a channel that later went public stays in private activity.
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values(
          buildJuniorSqlConversation({
            conversationId: "slack:C1:was-private",
            destinationId: destination?.id,
            visibility: "private",
            durationMs: 1_000,
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

      // A root counts as failed once, however many tree rows it has. Only
      // the root's own newest Turn counts: a failed child does not fail its
      // root, and a stop or a later Turn ends the failure.
      const failureRoots: Partial<JuniorSqlConversationInsert>[] = [
        { conversationId: "slack:C1:failed" },
        {
          conversationId: "slack:C1:failed-sibling",
          parentConversationId: "slack:C1:failed",
          rootConversationId: "slack:C1:failed",
        },
        { conversationId: "slack:C1:retried" },
        {
          conversationId: "slack:C1:retried-child",
          executionStatus: "failed",
          parentConversationId: "slack:C1:retried",
          rootConversationId: "slack:C1:retried",
        },
        { conversationId: "slack:C1:failed-stopped", stoppedAt: now },
      ];
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values(
          failureRoots.map((row) =>
            buildJuniorSqlConversation({
              destinationId: destination?.id,
              visibility: "public",
              ...row,
            }),
          ),
        );
      await recordTurnFailure("slack:C1:failed", "failed-1");
      await recordTurnFailure("slack:C1:retried", "retried-1");
      await recordTurnStart("slack:C1:retried", "retried-2");
      await recordTurnFailure("slack:C1:retried-child", "retried-child-1");
      await recordTurnFailure("slack:C1:failed-stopped", "failed-stopped-1");

      const directory = await readLocationDirectoryFromSql();
      expect(directory.locations).toHaveLength(2);
      expect(
        directory.locations.find(
          (location) => location.label === "#proj-alpha",
        ),
      ).toMatchObject({
        conversations: 5_004,
        durationMs: 10_004,
        failed: 1,
        tokens: 15_007,
      });
      expect(
        directory.locations.find((location) => location.label === "Dashboard"),
      ).toMatchObject({ conversations: 2, id: "dashboard", provider: "local" });
      expect(directory.privateActivity.conversations).toBe(3);
      expect(directory.activityDays).toHaveLength(90);
      expect(
        directory.activityDays.find((day) => day.date === "2026-06-15"),
      ).toEqual({
        date: "2026-06-15",
        privateConversations: 3,
        publicConversations: 5_003,
      });
      expect(directory.windowStart).toBe("2026-03-18T00:00:00.000Z");
      expect(directory.windowEnd).toBe("2026-06-15T00:00:00.000Z");
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
