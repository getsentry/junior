import { describe, expect, test, vi } from "vitest";
import { createJuniorApi } from "@/api";
import type { StoredSlackActor } from "@/chat/actor";
import { recordCodeChange } from "@/chat/code/store";
import { readPersonSpendDays } from "@/api/conversations/person-spend-days";
import { readConversationStatsFromSql } from "@/api/conversations/stats.query";
import { conversationStatsReportSchema } from "@/api/schema";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlConversationEventStore } from "@/chat/conversations/sql/history";
import { createSqlStore } from "@/chat/conversations/sql/store";
import { getStateAdapter } from "@/chat/state/adapter";
import { cacheKeyPrefix } from "@/chat/state/cache";
import { juniorConversationMetrics, juniorConversations } from "@/db/schema";
import {
  buildJuniorSqlConversation,
  createConfiguredJuniorSqlFixture,
} from "../../../fixtures/sql";
import {
  expectNoFullScan,
  expectPlanCost,
  expectSqlBudget,
  measureSql,
} from "../../../fixtures/sql-budget";
import { createWaitUntilCollector } from "../../../fixtures/wait-until";
import { recordTurn, turnActorIdentityId } from "../people/fixture";

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
        actorIdentityId: await turnActorIdentityId(fixture, {
          email: "Alice@Example.com",
          platform: "slack",
          slackUserId: "U1",
          teamId: "T1",
        }),
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
        actorIdentityId: await turnActorIdentityId(fixture, {
          email: "bob@example.com",
          platform: "slack",
          slackUserId: "U2",
          teamId: "T1",
        }),
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
      // A stop after a failed Turn reports `stopped`, so it is not failed.
      await fixture.sql.db().insert(juniorConversations).values({
        conversationId: "slack:C1:stopped",
        rootConversationId: "slack:C1:stopped",
        createdAt: childAt,
        lastActivityAt: childAt,
        updatedAt: childAt,
        executionStatus: "failed",
        stoppedAt: childAt,
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

      // Four people on one day, so the mean and the median per person differ.
      // One Turn has no cost, so its person counts with zero spend.
      for (const [index, costUsd] of [
        0.01,
        0.002,
        0.003,
        undefined,
      ].entries()) {
        const actor = {
          email: `person-${index}@example.com`,
          platform: "slack",
          slackUserId: `UP${index}`,
          teamId: "T1",
        } satisfies StoredSlackActor;
        const atMs = Date.parse("2026-06-01T09:00:00.000Z");
        const conversationId = `slack:C2:person-${index}`;
        await store.recordActivity({
          actor,
          conversationId,
          destination: { platform: "slack", teamId: "T1", channelId: "C2" },
          nowMs: atMs,
          source: "slack",
        });
        const turn = {
          actor,
          atMs,
          conversationId,
          ...(costUsd === undefined ? undefined : { costUsd }),
          durationMs: 100,
          runId: `turn-person-${index}`,
        };
        await recordTurn(fixture, turn);
        // A Turn written again replaces its metric rows, so it counts once.
        await recordTurn(fixture, turn);
      }

      // Two merged code changes split the cost of their conversation tree.
      for (const [number, mergedAt] of [
        [7, "2026-06-15T11:58:00.000Z"],
        [8, "2026-06-15T12:10:00.000Z"],
      ] as const) {
        await recordCodeChange(fixture.sql.db(), "github", {
          conversationIds: ["slack:C1:recent"],
          mergedAt: new Date(mergedAt),
          number,
          openedAt: new Date("2026-06-15T11:52:00.000Z"),
          providerId: `change-${number}`,
          repository: { name: "getsentry/junior", providerId: "repository-1" },
          state: "merged",
          updatedAt: new Date(mergedAt),
        });
      }

      // One round of hour-grained reads when the report is not cached.
      const response = await expectNoFullScan(() =>
        expectSqlBudget(
          () =>
            createJuniorApi().request(
              "http://localhost/api/conversations/stats",
            ),
          { statements: 5, serialRounds: 1 },
        ),
      );
      expect(response.status).toBe(200);
      const report = conversationStatsReportSchema.parse(await response.json());

      expect(report).toMatchObject({
        guardian: {
          allow: 4,
          ask: 1,
          costUsd: 0.018,
          deny: 1,
          requests: 6,
        },
        source: "conversation_index",
      });
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
          conversations: 5,
          costUsd: 0.004,
          date: "2026-06-15",
          durationMs: 1_604,
          inputTokens: 100,
          mergedCodeChangeCostUsd: 0.003,
          mergedCodeChanges: 2,
          tokens: 444,
        }),
      );
      // Turns of a verified person are theirs. A Turn whose Actor has no
      // verified email is spend with no person.
      expect(report.personSpendDays).toHaveLength(90);
      expect(report.personSpendDays.slice(-2)).toEqual([
        {
          date: "2026-06-14",
          medianPersonCostUsd: 0.0015,
          people: 1,
          personCostUsd: 0.0015,
          unattributedCostUsd: 0,
        },
        {
          date: "2026-06-15",
          medianPersonCostUsd: 0.003,
          people: 1,
          personCostUsd: 0.003,
          unattributedCostUsd: 0.001,
        },
      ]);
      expect(
        report.personSpendDays.find((day) => day.date === "2026-06-01"),
      ).toEqual({
        date: "2026-06-01",
        medianPersonCostUsd: 0.0025,
        people: 4,
        personCostUsd: 0.015,
        unattributedCostUsd: 0,
      });
      expect(
        report.personSpendDays.find((day) => day.date === "2026-06-08"),
      ).toEqual({
        date: "2026-06-08",
        people: 0,
        personCostUsd: 0,
        unattributedCostUsd: 0.002,
      });
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
      expect(report.metricHours?.at(-1)).toMatchObject({
        date: "2026-06-15T12",
        mergedCodeChangeCostUsd: 0.0015,
        mergedCodeChanges: 1,
      });
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
          conversations: 3,
          costUsd: 0.003,
          date: "2026-06-15T11",
          durationMs: 1_504,
          inputTokens: 100,
          mergedCodeChangeCostUsd: 0.0015,
          mergedCodeChanges: 1,
          tokens: 434,
        }),
      );
      expect(
        report.metricHours
          ?.filter((hour) => hour.conversations > 0)
          .reduce((sum, hour) => sum + hour.conversations, 0),
      ).toBe(6);

      // A later read keeps the Guardian hours of the last read and reads only
      // the reviews after it, plus the hour where its late-commit overlap
      // starts.
      const review = (at: string, toolCallId: string) => ({
        createdAtMs: Date.parse(at),
        data: {
          type: "guardian_action_reviewed" as const,
          turnId: "turn-later",
          toolCallId,
          toolName: "publishReport",
          costUsd: 0.005,
          decision: "deny" as const,
          riskLevel: "high" as const,
          userAuthorization: "low" as const,
        },
      });
      await eventStore.append("slack:C1:recent", [
        // Before the overlap, so the later read does not see it.
        review("2026-06-08T13:30:00.000Z", "tool-backdated"),
        // Before the last read, but committed after it.
        review("2026-06-15T12:34:00.000Z", "tool-late-commit"),
        review("2026-06-15T12:44:00.000Z", "tool-after"),
      ]);
      vi.setSystemTime(new Date("2026-06-15T12:45:00.000Z"));
      const later = await measureSql(readConversationStatsFromSql);
      expect(later.sql.statements).toBe(5);
      expect(later.result.guardian.metricHours?.at(0)).toEqual(
        report.guardian.metricHours?.at(0),
      );
      expect(later.result.guardian.metricHours?.at(-1)).toEqual({
        allow: 1,
        ask: 0,
        costUsd: 0.014,
        date: "2026-06-15T12",
        deny: 2,
        requests: 3,
      });
      expect(later.result.guardian.requests).toBe(8);
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

      // One Turn each, with no Actor Identity.
      await fixture.sql
        .db()
        .insert(juniorConversationMetrics)
        .values(
          Array.from({ length: 5_001 }, (_, index) =>
            (["duration_ms", "cost_micro_usd"] as const).map((metric) => ({
              conversationId: `internal:stats-cap:${index}`,
              metric,
              occurredAt: now,
              runId: "turn-1",
              updatedAt: now,
              value: 2,
            })),
          ).flat(),
        );

      // Daily spend reads one row per Identity and day, not one per Turn.
      // Plan costs follow table statistics, so gather them first.
      await fixture.sql.query("analyze");
      await expectPlanCost(
        () =>
          readPersonSpendDays(fixture.sql.db(), {
            start: new Date("2026-03-18T00:00:00.000Z"),
            end: new Date(),
          }),
        14,
      );

      const response = await createJuniorApi().request(
        "http://localhost/api/conversations/stats",
      );
      expect(response.status).toBe(200);
      const report = conversationStatsReportSchema.parse(await response.json());

      expect(report.metricDays.at(-1)?.conversations).toBe(5_001);
      expect(report.personSpendDays.at(-1)).toMatchObject({
        people: 0,
        unattributedCostUsd: 0.010002,
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
  test("serves a cached report and refreshes it once when stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    const fixture = createConfiguredJuniorSqlFixture();
    const background = createWaitUntilCollector();
    const api = createJuniorApi({ waitUntil: background.fn });
    const readStats = async () =>
      conversationStatsReportSchema.parse(
        await (
          await api.request("http://localhost/api/conversations/stats")
        ).json(),
      );
    const addConversation = async (index: number) => {
      const at = new Date();
      await fixture.sql
        .db()
        .insert(juniorConversations)
        .values(
          buildJuniorSqlConversation({
            conversationId: `internal:stats-cache:${index}`,
            source: "internal",
            destination: null,
            actor: null,
            createdAt: at,
            lastActivityAt: at,
            updatedAt: at,
          }),
        );
    };

    try {
      await migrateSchema(fixture.sql);
      await addConversation(1);
      // An entry from an older report shape is reloaded once.
      const state = getStateAdapter();
      await state.connect();
      await state.set(
        `${cacheKeyPrefix("core")}conversation-stats`,
        { value: { refreshAtMs: 0, report: { totals: {} } } },
        60_000,
      );
      const reloaded = await measureSql(() =>
        Promise.all([readStats(), readStats()]),
      );
      expect(reloaded.sql.statements).toBe(5);
      const [first] = reloaded.result;
      expect(reloaded.result).toEqual([first, first]);
      expect(first?.metricDays.at(-1)?.conversations).toBe(1);

      await addConversation(2);
      vi.setSystemTime(new Date("2026-06-15T12:04:00.000Z"));
      const fresh = await measureSql(readStats);
      expect(fresh.sql.statements).toBe(0);
      expect(fresh.result).toEqual(first);
      expect(background.pendingCount()).toBe(0);

      // A stale report is served at once. Concurrent requests start one
      // refresh between them.
      vi.setSystemTime(new Date("2026-06-15T12:06:00.000Z"));
      const stale = await measureSql(async () => {
        const reports = await Promise.all([readStats(), readStats()]);
        expect(background.pendingCount()).toBe(2);
        await background.flush();
        return reports;
      });
      expect(stale.result).toEqual([first, first]);
      expect(stale.sql.statements).toBe(5);

      const refreshed = await readStats();
      expect(refreshed.generatedAt).toBe("2026-06-15T12:06:00.000Z");
      expect(refreshed.metricDays.at(-1)?.conversations).toBe(2);
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});
