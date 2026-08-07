import { eq } from "drizzle-orm";
import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { readConversationStatsFromSql } from "@/api/conversations/stats.query";
import { conversationStatsReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { juniorConversations } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../../fixtures/sql";

describe("conversation stats API", () => {
  test("serves the route through its response schema", async () => {
    const fixture = createConfiguredJuniorSqlFixture();
    try {
      await migrateSchema(fixture.sql);
      const response = await createJuniorApi().request(
        "http://localhost/api/conversations/stats",
      );
      expect(response.status).toBe(200);
      conversationStatsReportSchema.parse(await response.json());
    } finally {
      await fixture.close();
    }
  });

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
      await fixture.sql
        .db()
        .update(juniorConversations)
        .set({
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            reasoningTokens: 5,
            totalTokens: 999,
            cost: { input: 0.001, output: 0.002, total: 0.003 },
          },
        })
        .where(eq(juniorConversations.conversationId, "slack:C1:recent"));
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
        nowMs: Date.parse("2026-02-01T10:00:00.000Z"),
      });
      const childAt = new Date("2026-06-15T11:55:00.000Z");
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values({
          conversationId: "advisor:child",
          parentConversationId: "slack:C1:recent",
          rootConversationId: "slack:C1:recent",
          durationMs: 4,
          usage: { totalTokens: 7 },
          createdAt: childAt,
          lastActivityAt: childAt,
          updatedAt: childAt,
          executionStatus: "idle",
        });
      const eventStore = createSqlConversationEventStore(fixture.sql);
      await eventStore.append("slack:C1:recent", [
        {
          createdAtMs: Date.parse("2026-06-15T11:52:00.000Z"),
          data: {
            type: "guardian_action_reviewed",
            turnId: "turn-recent",
            toolCallId: "tool-allow",
            toolName: "publishReport",
            costUsd: 0.001,
            decision: "allow",
            riskLevel: "low",
            userAuthorization: "high",
          },
        },
        {
          createdAtMs: Date.parse("2026-06-15T11:53:00.000Z"),
          data: {
            type: "guardian_action_reviewed",
            turnId: "turn-recent",
            toolCallId: "tool-ask",
            toolName: "publishReport",
            costUsd: 0.002,
            decision: "ask",
            riskLevel: "medium",
            userAuthorization: "low",
          },
        },
      ]);
      await eventStore.append("advisor:child", [
        {
          createdAtMs: Date.parse("2026-06-15T11:56:00.000Z"),
          data: {
            type: "guardian_action_reviewed",
            turnId: "turn-child",
            toolCallId: "tool-deny",
            toolName: "deleteReport",
            costUsd: 0.003,
            decision: "deny",
            riskLevel: "high",
            userAuthorization: "unknown",
          },
        },
      ]);

      const report = await readConversationStatsFromSql();

      expect(report).toMatchObject({
        active: 1,
        conversations: 3,
        costUsd: 0.0045,
        durationMs: 2_004,
        failed: 1,
        guardian: {
          allow: 1,
          ask: 1,
          costUsd: 0.006,
          deny: 1,
          requests: 3,
        },
        tokens: 157,
        source: "conversation_index",
      });
      expect(report.actors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversations: 1,
            costUsd: 0.003,
            durationMs: 1_504,
            label: "alice@example.com",
            tokens: 127,
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
      expect(report.guardian.metricDays.at(-1)).toEqual({
        allow: 1,
        ask: 1,
        costUsd: 0.006,
        date: "2026-06-15",
        deny: 1,
        requests: 3,
      });
      expect(report.metricDays.at(-1)).toEqual(
        expect.objectContaining({
          conversations: 3,
          costUsd: 0.0045,
          date: "2026-06-15",
          durationMs: 2_004,
          tokens: 157,
        }),
      );
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  test("aggregates every conversation beyond the former row cap", async () => {
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
          Array.from({ length: 5_001 }, (_, index) =>
            buildJuniorSqlConversation({
              conversationId: `internal:stats-cap:${index}`,
              source: "internal",
              destination: null,
              actor: null,
              createdAt: now,
              durationMs: 2,
              lastActivityAt: now,
              usage: { totalTokens: 3 },
              updatedAt: now,
            }),
          ),
        );

      const report = await readConversationStatsFromSql();

      expect(report).toMatchObject({
        conversations: 5_001,
        durationMs: 10_002,
        tokens: 15_003,
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
