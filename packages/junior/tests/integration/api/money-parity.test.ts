import { afterEach, describe, expect, test, vi } from "vitest";
import { readCacheWarmingSavings } from "@/api/cache-warming/savings";
import { readConversationStatsFromSql } from "@/api/conversations/stats.query";
import { readPeopleListFromSql } from "@/api/people/list.query";
import { readPersonalSpendFromSql } from "@/api/people/spend.query";
import { recordWarmupCost } from "@/chat/cache-warming/savings";
import { migrateSchema } from "@/chat/conversations/sql/migrations";
import { createSqlStore } from "@/chat/conversations/sql/store";
import type { StoredSlackActor } from "@/chat/actor";
import { createConfiguredJuniorSqlFixture } from "../../fixtures/sql";
import { turnActorIdentityId } from "./people/fixture";

const NOW_MS = Date.parse("2026-06-15T12:00:00.000Z");
const DAY_MS = 86_400_000;
const ALICE = {
  email: "alice@example.com",
  platform: "slack",
  slackUserId: "U1",
  teamId: "T1",
} satisfies StoredSlackActor;

// Provider costs: tokens times a price per million tokens. Cache reads cost
// $0.30 per million, so most costs end in a fraction of a micro-USD.
function providerCost(index: number): number {
  const input = 1_000 + ((index * 7_919) % 50_000);
  const cacheRead = (index * 104_729) % 200_000;
  const output = 100 + ((index * 31) % 4_000);
  return (input * 3 + cacheRead * 0.3 + output * 15) / 1_000_000;
}

// The old float total, with the 1e-12 rounding the old reads applied.
function floatTotal(costs: readonly number[]): number {
  return costs.reduce(
    (total, cost) => Math.round((total + cost) * 1e12) / 1e12,
    0,
  );
}

// Each stored amount rounds once to whole micro-USD.
function microUsdTotal(costs: readonly number[]): number {
  return (
    costs.reduce((total, cost) => total + Math.round(cost * 1_000_000), 0) /
    1_000_000
  );
}

describe("money totals in micro-USD", () => {
  afterEach(() => vi.useRealTimers());

  test("match the float totals within half a micro-USD per stored amount", async () => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ["Date"] });
    const fixture = createConfiguredJuniorSqlFixture();
    const store = createSqlStore(fixture.sql);
    try {
      await migrateSchema(fixture.sql);
      const actorIdentityId = await turnActorIdentityId(fixture, ALICE);
      const costs = Array.from({ length: 60 }, (_, index) =>
        providerCost(index),
      );
      for (const [index, costUsd] of costs.entries()) {
        const conversationId = `slack:C1:${index % 6}`;
        const atMs = NOW_MS - (index % 6) * DAY_MS - index * 60_000;
        if (index < 6) {
          await store.recordActivity({
            actor: ALICE,
            conversationId,
            destination: { channelId: "C1", platform: "slack", teamId: "T1" },
            nowMs: atMs,
            source: "slack",
          });
        }
        await store.recordExecution({
          actorIdentityId,
          conversationId,
          createdAtMs: atMs,
          execution: {
            runId: `turn-${index}`,
            status: "idle",
            updatedAtMs: atMs,
          },
          lastActivityAtMs: atMs,
          metrics: { durationMs: 100, usage: { cost: { total: costUsd } } },
          source: "slack",
          updatedAtMs: atMs,
        });
        await recordWarmupCost("anthropic/claude-opus-5.5", costUsd);
      }

      const expected = microUsdTotal(costs);
      // Each Run rounds its cost once, so a total can move by up to half a
      // micro-USD per Run from the float total.
      const bound = costs.length * 0.5e-6;
      expect(Math.abs(expected - floatTotal(costs))).toBeLessThanOrEqual(bound);

      const spend = await readPersonalSpendFromSql(ALICE.email, NOW_MS);
      expect(spend.sevenDaysUsd).toBe(expected);

      const people = await readPeopleListFromSql();
      expect(people.people[0]?.windows[7].costUsd).toBe(expected);

      const stats = await readConversationStatsFromSql();
      expect(
        microUsdTotal(stats.metricDays.map((day) => day.costUsd ?? 0)),
      ).toBe(expected);
      expect(stats.metricDays.at(-1)?.costUsd).toBe(
        microUsdTotal(costs.filter((_, index) => index % 6 === 0)),
      );

      const savings = await readCacheWarmingSavings(7, NOW_MS);
      expect(savings.totals.warmupCostUsd).toBe(expected);
    } finally {
      await fixture.close();
    }
  });
});
