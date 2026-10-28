import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
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
  test("aggregates normalized SQL conversation dimensions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:37:00.000Z"));
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
            cachedInputTokens: 300,
            cacheCreationTokens: 7,
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
        createdAtMs: Date.parse("2026-06-14T23:55:00.000Z"),
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
        conversationId: "local:test:scheduler-daily",
        destination: {
          platform: "local" as const,
          conversationId: "local:test:scheduler-daily",
        },
        source: "scheduler",
        nowMs: Date.parse("2026-06-15T10:00:00.000Z"),
      });
      await store.recordExecution({
        conversationId: "local:test:scheduler-daily",
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
      await fixture.sql.db().insert(juniorConversations).values({
        conversationId: "advisor:child",
        parentConversationId: "slack:C1:recent",
        rootConversationId: "slack:C1:recent",
        createdAt: childAt,
        lastActivityAt: childAt,
        updatedAt: childAt,
        executionStatus: "idle",
      });
      await store.recordExecution({
        conversationId: "advisor:child",
        createdAtMs: childAt.getTime(),
        execution: {
          runId: "turn-child",
          status: "idle",
          updatedAtMs: childAt.getTime(),
        },
        lastActivityAtMs: childAt.getTime(),
        metrics: { durationMs: 4, usage: { totalTokens: 7 } },
        source: "internal",
        updatedAtMs: childAt.getTime(),
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

      for (const [name, at] of [
        ["before-hour-window", "2026-06-08T12:59:59.999Z"],
        ["first-hour", "2026-06-08T13:00:00.000Z"],
        ["current-hour", "2026-06-15T12:15:00.000Z"],
      ] as const) {
        const conversationId = `local:test:${name}`;
        const turnId = `turn-${name}`;
        const atMs = Date.parse(at);
        await store.recordActivity({
          conversationId,
          destination: { platform: "local", conversationId },
          actor: {
            fullName: "Boundary Actor",
            platform: "slack",
            slackUserId: "U4",
            teamId: "T1",
          },
          source: "internal",
          nowMs: atMs,
        });
        await store.recordExecution({
          conversationId,
          createdAtMs: atMs,
          lastActivityAtMs: atMs,
          updatedAtMs: atMs,
          execution: { runId: turnId, status: "idle", updatedAtMs: atMs },
          metrics: {
            durationMs: 100,
            usage: { totalTokens: 10, cost: { total: 0.001 } },
          },
          source: "internal",
        });
        await eventStore.append(conversationId, [
          {
            createdAtMs: atMs,
            data: {
              type: "guardian_action_reviewed",
              turnId,
              toolCallId: `tool-${name}`,
              toolName: "publishReport",
              costUsd: 0.004,
              decision: "allow",
              riskLevel: "low",
              userAuthorization: "high",
            },
          },
        ]);
      }

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations/stats",
      );
      expect(response.status).toBe(200);
      const report = conversationStatsReportSchema.parse(await response.json());

      expect(report).toMatchObject({
        active: 1,
        cachedInputTokens: 300,
        cacheCreationTokens: 7,
        conversations: 6,
        costUsd: 0.0075,
        durationMs: 2_304,
        failed: 1,
        inputTokens: 100,
        guardian: {
          allow: 4,
          ask: 1,
          costUsd: 0.018,
          deny: 1,
          requests: 6,
        },
        tokens: 494,
        source: "conversation_index",
      });
      expect(report.actors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            conversations: 1,
            costUsd: 0.003,
            durationMs: 1_504,
            label: "alice@example.com",
            tokens: 434,
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
        allow: 2,
        ask: 1,
        costUsd: 0.01,
        date: "2026-06-15",
        deny: 1,
        requests: 4,
      });
      expect(report.guardian.metricHours).toHaveLength(7 * 24);
      expect(report.guardian.metricSixHours).toHaveLength(7 * 4);
      expect(
        report.guardian.metricDays.find((day) => day.date === "2026-06-08"),
      ).toEqual({
        allow: 2,
        ask: 0,
        costUsd: 0.008,
        date: "2026-06-08",
        deny: 0,
        requests: 2,
      });
      expect(report.guardian.metricHours?.at(0)).toEqual({
        allow: 1,
        ask: 0,
        costUsd: 0.004,
        date: "2026-06-08T13",
        deny: 0,
        requests: 1,
      });
      expect(report.guardian.metricSixHours?.at(-1)).toEqual({
        allow: 1,
        ask: 0,
        costUsd: 0.004,
        date: "2026-06-15T12",
        deny: 0,
        requests: 1,
      });
      expect(
        report.guardian.metricHours?.find(
          (hour) => hour.date === "2026-06-15T11",
        ),
      ).toEqual({
        allow: 1,
        ask: 1,
        costUsd: 0.006,
        date: "2026-06-15T11",
        deny: 1,
        requests: 3,
      });
      expect(report.metricDays.at(-2)).toEqual(
        expect.objectContaining({
          conversations: 0,
          costUsd: 0.0015,
          date: "2026-06-14",
          durationMs: 500,
          tokens: 30,
        }),
      );
      expect(report.metricDays.at(-1)).toEqual(
        expect.objectContaining({
          cachedInputTokens: 300,
          cacheCreationTokens: 7,
          conversations: 4,
          costUsd: 0.004,
          date: "2026-06-15",
          durationMs: 1_604,
          inputTokens: 100,
          tokens: 444,
        }),
      );
      expect(report.metricHours).toHaveLength(7 * 24);
      expect(report.metricSixHours).toHaveLength(7 * 4);
      expect(
        report.metricDays.find((day) => day.date === "2026-06-08"),
      ).toMatchObject({
        conversations: 2,
        costUsd: 0.002,
        durationMs: 200,
        tokens: 20,
      });
      expect(report.metricHours?.at(0)).toMatchObject({
        conversations: 1,
        costUsd: 0.001,
        date: "2026-06-08T13",
        durationMs: 100,
        tokens: 10,
      });
      expect(report.metricSixHours?.at(-1)).toMatchObject({
        conversations: 1,
        costUsd: 0.001,
        date: "2026-06-15T12",
        durationMs: 100,
        tokens: 10,
      });
      expect(report.metricHours?.at(-1)?.date).toBe("2026-06-15T12");
      expect(
        report.metricHours?.find((hour) => hour.date === "2026-06-14T23"),
      ).toEqual(
        expect.objectContaining({
          conversations: 0,
          costUsd: 0.0015,
          date: "2026-06-14T23",
          durationMs: 500,
          tokens: 30,
        }),
      );
      expect(
        report.metricHours?.find((hour) => hour.date === "2026-06-15T11"),
      ).toEqual(
        expect.objectContaining({
          cachedInputTokens: 300,
          cacheCreationTokens: 7,
          conversations: 2,
          costUsd: 0.003,
          date: "2026-06-15T11",
          durationMs: 1_504,
          inputTokens: 100,
          tokens: 434,
        }),
      );
      expect(
        report.metricHours
          ?.filter((hour) => hour.conversations > 0)
          .reduce((sum, hour) => sum + hour.conversations, 0),
      ).toBe(5);
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

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations/stats",
      );
      expect(response.status).toBe(200);
      const report = conversationStatsReportSchema.parse(await response.json());

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
