import { describe, expect, test, vi } from "vitest";
import { readConversationStatsFromSql } from "@/api/conversations/stats.query";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../../fixtures/sql";

describe("conversation stats API", () => {
  test("aggregates normalized SQL conversation dimensions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      await store.recordActivity({
        conversationId: "slack:C1:recent",
        channelName: "proj-alpha",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C1",
        },
        actor: {
          email: "Alice@Example.com",
          fullName: "Alice Example",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        },
        source: "slack",
        visibility: "public",
        nowMs: Date.parse("2026-06-15T11:50:00.000Z"),
      });
      await store.recordExecution({
        conversationId: "slack:C1:recent",
        createdAtMs: Date.parse("2026-06-15T11:50:00.000Z"),
        execution: {
          runId: "turn-recent",
          status: "idle",
          updatedAtMs: Date.parse("2026-06-15T11:51:00.000Z"),
        },
        lastActivityAtMs: Date.parse("2026-06-15T11:51:00.000Z"),
        metrics: {
          durationMs: 1_500,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 5,
            cost: { input: 0.001, output: 0.002, total: 0.003 },
          },
        },
        source: "slack",
        updatedAtMs: Date.parse("2026-06-15T11:51:00.000Z"),
      });
      await store.recordExecution({
        conversationId: "slack:D1:failed",
        createdAtMs: Date.parse("2026-06-15T11:00:00.000Z"),
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "D1",
        },
        execution: {
          runId: "turn-failed",
          status: "failed",
          updatedAtMs: Date.parse("2026-06-15T11:01:00.000Z"),
        },
        lastActivityAtMs: Date.parse("2026-06-15T11:01:00.000Z"),
        metrics: {
          durationMs: 500,
          usage: { totalTokens: 30, cost: { total: 0.0015 } },
        },
        actor: {
          email: "bob@example.com",
          fullName: "Bob Example",
          platform: "slack",
          slackUserId: "U2",
          teamId: "T1",
        },
        source: "slack",
        updatedAtMs: Date.parse("2026-06-15T11:01:00.000Z"),
        visibility: "private",
      });
      await store.recordActivity({
        conversationId: "scheduler:daily",
        source: "scheduler",
        nowMs: Date.parse("2026-06-15T10:00:00.000Z"),
      });
      await store.recordExecution({
        conversationId: "scheduler:daily",
        createdAtMs: Date.parse("2026-06-15T10:00:00.000Z"),
        execution: {
          runId: "turn-scheduler",
          status: "running",
          updatedAtMs: Date.parse("2026-06-15T10:00:00.000Z"),
        },
        metrics: null,
        lastActivityAtMs: Date.parse("2026-06-15T10:00:00.000Z"),
        source: "scheduler",
        updatedAtMs: Date.parse("2026-06-15T10:00:00.000Z"),
      });
      await store.recordActivity({
        conversationId: "slack:C2:old",
        destination: {
          platform: "slack",
          teamId: "T1",
          channelId: "C2",
        },
        actor: {
          fullName: "Old Actor",
          platform: "slack",
          slackUserId: "U3",
          teamId: "T1",
        },
        source: "slack",
        visibility: "public",
        nowMs: Date.parse("2026-06-01T10:00:00.000Z"),
      });
      await store.ensureChildConversation({
        conversationId: "advisor:child",
        parentConversationId: "slack:C1:recent",
        nowMs: Date.parse("2026-06-15T11:55:00.000Z"),
      });

      const report = await readConversationStatsFromSql();

      expect(report).toMatchObject({
        active: 1,
        conversations: 3,
        costUsd: 0.0045,
        durationMs: 2_000,
        failed: 1,
        tokens: 150,
        sampleLimit: 5_000,
        sampleSize: 3,
        source: "conversation_index",
        truncated: false,
      });
      expect(report.actors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversations: 1,
            costUsd: 0.003,
            durationMs: 1_500,
            label: "alice@example.com",
            tokens: 120,
          }),
          expect.objectContaining({
            conversations: 1,
            costUsd: 0.0015,
            durationMs: 500,
            failed: 1,
            label: "bob@example.com",
            tokens: 30,
          }),
          expect.objectContaining({
            conversations: 1,
            label: "Junior Scheduler",
          }),
        ]),
      );
      expect(report.locations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: "#proj-alpha" }),
          expect.objectContaining({ label: "Direct Message" }),
          expect.objectContaining({ label: "Scheduler" }),
        ]),
      );
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("marks a sample truncated when it reaches the cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();

    try {
      await migrateSchema(fixture.sql);
      const now = new Date("2026-06-15T11:00:00.000Z");
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values(
          Array.from({ length: 5_000 }, (_, index) =>
            buildJuniorSqlConversation({
              conversationId: `internal:stats-cap:${index}`,
              source: "internal",
              destination: null,
              actor: null,
              createdAt: now,
              lastActivityAt: now,
              updatedAt: now,
            }),
          ),
        );

      const report = await readConversationStatsFromSql();

      expect(report.sampleSize).toBe(5_000);
      expect(report.truncated).toBe(true);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
