import { expectNoFullScan, expectSqlBudget } from "../../fixtures/sql-budget";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  cacheWarmingBreakerListSchema,
  cacheWarmingHourlyReportSchema,
  cacheWarmingSavingsReportSchema,
} from "@/api/schema";
import {
  recordBreakerEvent,
  recordModelCallCache,
  recordWarmupSkipped,
} from "@/chat/cache-warming/counters";
import { connectedState } from "@/chat/cache-warming/request";
import {
  addHistoryPeriod,
  addHistoryWarmupCost,
  recordIdlePeriodSavings,
  recordWarmup,
  replaceHistorySavings,
  type HistorySavings,
} from "@/chat/cache-warming/savings";
import { closeDb, getDb } from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import { pruneHourlyStats, readHourlyStats } from "@/stats";

const BASE_URL = "https://junior.example.com";
const ADMIN = "admin@example.com";
const PERSON = "person@example.com";
const OPEN_KEY = "junior:cache_warming:breaker:anthropic:open";
const OUTCOMES_KEY = "junior:cache_warming:breaker:anthropic:outcomes";
const EVENTS_KEY = "junior:cache_warming:breaker:anthropic:events";
const MODEL_ID = "anthropic/claude-opus-5.5";
const HOUR = 60 * 60 * 1_000;

// The viewer resolves once here, so a SQL budget counts only the route.
async function authenticatedApi(email: string) {
  const viewer = await resolveViewerUser(email);
  if (!viewer) throw new Error(`missing viewer for ${email}`);
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function listBreakers(app: Awaited<ReturnType<typeof authenticatedApi>>) {
  const response = await app.request(`${BASE_URL}/api/cache-warming/breakers`);
  expect(response.status).toBe(200);
  return cacheWarmingBreakerListSchema.parse(await response.json()).breakers;
}

describe("cache warming API", () => {
  beforeEach(async () => {
    await resolveViewerUser(ADMIN);
    await resolveViewerUser(PERSON);
    await setUserAdminFromSql(getDb(), ADMIN, true);
  });

  afterEach(async () => {
    vi.useRealTimers();
    const state = await connectedState();
    await state.delete(OPEN_KEY);
    await state.delete(OUTCOMES_KEY);
    await state.delete(EVENTS_KEY);
    await closeDb();
  });

  it("lets an admin turn warming back on after the breaker opens", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-09T08:00:00.000Z"));
    const state = await connectedState();
    await state.set(OPEN_KEY, true, 60_000);
    await state.appendToList(OUTCOMES_KEY, 1, { maxLength: 20 });
    const admin = await authenticatedApi(ADMIN);
    const person = await authenticatedApi(PERSON);

    // The breaker stops warming for everyone, so only an admin can close it.
    expect(
      (await person.request(`${BASE_URL}/api/cache-warming/breakers`)).status,
    ).toBe(403);
    expect(
      (
        await person.request(
          `${BASE_URL}/api/cache-warming/breakers/anthropic`,
          {
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(403);
    expect(await state.get(OPEN_KEY)).toBe(true);

    // Only providers of the models Junior runs are listed.
    expect(await listBreakers(admin)).toEqual([
      { provider: "anthropic", open: true },
    ]);
    const closed = await admin.request(
      `${BASE_URL}/api/cache-warming/breakers/anthropic`,
      { method: "DELETE" },
    );
    expect(closed.status).toBe(200);
    expect(await listBreakers(admin)).toEqual([
      {
        provider: "anthropic",
        open: false,
        lastClosedAt: "2031-05-09T08:00:00.000Z",
      },
    ]);
    // Old misses must not reopen the breaker on the next miss.
    expect(await state.getList(OUTCOMES_KEY)).toEqual([]);

    expect(
      (
        await admin.request(
          `${BASE_URL}/api/cache-warming/breakers/constructor`,
          {
            method: "DELETE",
          },
        )
      ).status,
    ).toBe(404);
  });

  it("serves net savings per day of the range and in total", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const person = await authenticatedApi(PERSON);
    vi.setSystemTime(new Date("2031-05-09T08:00:00.000Z"));
    await recordIdlePeriodSavings(
      "anthropic/claude-opus-5.5",
      { hit: true, oracleUsd: 0.8, savedUsd: 1 },
      true,
    );
    await recordWarmup("anthropic/claude-opus-5.5", {
      costUsd: 0.3,
      refreshed: true,
      sentAs: "reply",
    });
    vi.setSystemTime(new Date("2031-05-10T20:00:00.000Z"));
    await recordIdlePeriodSavings(
      "anthropic/claude-opus-5.5",
      { hit: false, oracleUsd: 0.2, savedUsd: 0 },
      false,
    );
    await recordWarmup("anthropic/claude-opus-5.5", {
      costUsd: 0.1,
      refreshed: true,
      sentAs: "reply",
    });
    // A day from history counts in the totals, with its recorded warmup
    // cost.
    const history: HistorySavings = {};
    addHistoryPeriod(
      history,
      Date.parse("2031-05-08T12:00:00.000Z"),
      "anthropic/claude-opus-5.5",
      { hit: true, oracleUsd: 2, savedUsd: 3 },
    );
    addHistoryWarmupCost(history, "2031-05-08", 0.5);
    await replaceHistorySavings(history, {
      start: "2031-05-08",
      end: "2031-05-09",
    });

    // One read of the stats rows of the range, however many days it spans.
    const response = await expectNoFullScan(() =>
      expectSqlBudget(
        () => person.request(`${BASE_URL}/api/cache-warming/savings?days=7`),
        { statements: 1, serialRounds: 1 },
      ),
    );
    expect(response.status).toBe(200);
    const report = cacheWarmingSavingsReportSchema.parse(await response.json());
    expect(report.days.map((day) => day.date)).toEqual([
      "2031-05-04",
      "2031-05-05",
      "2031-05-06",
      "2031-05-07",
      "2031-05-08",
      "2031-05-09",
      "2031-05-10",
    ]);
    expect(report.days.at(-3)).toMatchObject({
      date: "2031-05-08",
      history: true,
      savedUsd: expect.closeTo(3),
      warmupCostUsd: expect.closeTo(0.5),
      netSavingsUsd: expect.closeTo(2.5),
    });
    expect(report.days.at(-1)).toMatchObject({
      history: false,
      idlePeriods: 1,
      hits: 0,
      netSavingsUsd: expect.closeTo(-0.1),
      unwarmedIdlePeriods: 1,
      unwarmedOracleSavingsUsd: expect.closeTo(0.2),
    });
    expect(report.totals).toMatchObject({
      idlePeriods: 3,
      hits: 2,
      savedUsd: expect.closeTo(4),
      warmupCostUsd: expect.closeTo(0.9),
      netSavingsUsd: expect.closeTo(3.1),
      oracleSavingsUsd: expect.closeTo(3),
      liveOracleSavingsUsd: expect.closeTo(1),
      effectiveness: expect.closeTo(3.1 / 3),
      historyDays: 1,
    });

    // A range with no idle periods has no effectiveness.
    vi.setSystemTime(new Date("2031-05-20T08:00:00.000Z"));
    const empty = cacheWarmingSavingsReportSchema.parse(
      await (
        await person.request(`${BASE_URL}/api/cache-warming/savings?days=1`)
      ).json(),
    );
    expect(empty.totals).toMatchObject({ idlePeriods: 0, effectiveness: null });
    expect(
      (await person.request(`${BASE_URL}/api/cache-warming/savings?days=5`))
        .status,
    ).toBe(400);
  });

  it("serves an hourly window, and the same window a week earlier", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const person = await authenticatedApi(PERSON);
    const at = (iso: string) => vi.setSystemTime(new Date(iso));
    const call = (cacheRead: number, cacheWrite: number) =>
      recordModelCallCache(MODEL_ID, { input: 1_000, cacheRead, cacheWrite });

    at("2031-06-03T10:20:00.000Z");
    await call(90_000, 9_000);
    at("2031-06-10T09:10:00.000Z");
    // A provider that drops its cache shows as a full rewrite.
    await call(0, 99_000);
    await call(90_000, 9_000);
    await recordWarmup(MODEL_ID, {
      costUsd: 0.1,
      refreshed: true,
      sentAs: "no_reply",
    });
    await recordWarmup(MODEL_ID, {
      costUsd: 0.1,
      refreshed: false,
      sentAs: "tool_wait",
    });
    await recordWarmupSkipped("unlikely_return");
    await recordBreakerEvent("anthropic", "opened");
    at("2031-06-10T11:40:00.000Z");
    await recordWarmupSkipped("breaker_open");
    // The warmed period's return wrote the cache anyway.
    await recordIdlePeriodSavings(
      MODEL_ID,
      { hit: false, oracleUsd: 0.5, savedUsd: 0 },
      true,
      1,
    );
    await call(90_000, 9_000);

    // One read of both windows.
    const response = await expectSqlBudget(
      () =>
        person.request(
          `${BASE_URL}/api/cache-warming/hourly?start=2031-06-10T09:00:00Z&end=2031-06-10T11:59:00Z`,
        ),
      { statements: 1, serialRounds: 1 },
    );
    expect(response.status).toBe(200);
    const report = cacheWarmingHourlyReportSchema.parse(await response.json());
    expect(report).toMatchObject({
      start: "2031-06-10T09:00:00.000Z",
      end: "2031-06-10T12:00:00.000Z",
    });
    expect(
      report.hours.map((hour) => [
        hour.hour,
        hour.modelCache.calls,
        hour.warmups.sent,
      ]),
    ).toEqual([
      ["2031-06-10T09:00:00.000Z", 2, 2],
      ["2031-06-10T10:00:00.000Z", 0, 0],
      ["2031-06-10T11:00:00.000Z", 1, 0],
    ]);
    expect(report.hours[0]?.savings).toMatchObject({
      warmupCostUsd: expect.closeTo(0.2),
      netSavingsUsd: expect.closeTo(-0.2),
      effectiveness: null,
    });
    expect(report.hours[2]?.savings).toMatchObject({
      idlePeriods: 1,
      effectiveness: 0,
    });
    expect(report.totals.modelCache).toEqual({
      calls: 3,
      fullRewrites: 1,
      inputTokens: 3_000 + 99_000 + 2 * 99_000,
      cacheWriteTokens: 99_000 + 2 * 9_000,
      cacheReadTokens: 180_000,
      writeShare: expect.closeTo(117_000 / 300_000),
      fullRewriteRate: expect.closeTo(1 / 3),
    });
    expect(report.totals.modelCacheByModel).toEqual([
      { ...report.totals.modelCache, model: MODEL_ID },
    ]);
    expect(report.totals.warmups).toEqual({
      sent: 2,
      missed: 1,
      warmedRewrites: 1,
      skipped: 2,
      sentByTurnEnding: { no_reply: 1, tool_wait: 1 },
      skipReasons: { breaker_open: 1, unlikely_return: 1 },
    });
    expect(report.totals).toMatchObject({ breakerOpened: 1, breakerClosed: 0 });
    expect(report.lastWeek).toMatchObject({
      start: "2031-06-03T09:00:00.000Z",
      end: "2031-06-03T12:00:00.000Z",
      modelCache: { calls: 1, writeShare: expect.closeTo(9_000 / 100_000) },
    });
    // Hourly counters also count per day.
    const day = cacheWarmingSavingsReportSchema.parse(
      await (
        await person.request(`${BASE_URL}/api/cache-warming/savings?days=1`)
      ).json(),
    );
    expect(day.totals).toMatchObject({
      idlePeriods: 1,
      warmupCostUsd: expect.closeTo(0.2),
    });

    // The default window is the last 24 hours, the current one included.
    const recent = cacheWarmingHourlyReportSchema.parse(
      await (
        await person.request(`${BASE_URL}/api/cache-warming/hourly`)
      ).json(),
    );
    expect(recent.hours).toHaveLength(24);
    expect(recent.end).toBe("2031-06-10T12:00:00.000Z");
    expect(recent.totals.modelCache.calls).toBe(3);
    for (const query of [
      "start=2031-05-20T00:00:00Z&end=2031-06-10T00:00:00Z",
      "start=2031-06-10T10:00:00Z&end=2031-06-10T09:00:00Z",
      "start=yesterday",
    ]) {
      expect(
        (await person.request(`${BASE_URL}/api/cache-warming/hourly?${query}`))
          .status,
      ).toBe(400);
    }
  });

  it("deletes hourly counters after 15 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const nowMs = Date.parse("2031-07-20T12:00:00.000Z");
    for (const days of [16, 14]) {
      vi.setSystemTime(nowMs - days * 24 * HOUR);
      await recordModelCallCache(MODEL_ID, {
        input: 1,
        cacheRead: 0,
        cacheWrite: 0,
      });
    }
    await pruneHourlyStats(nowMs);
    const hours = await readHourlyStats(
      ["model_cache"],
      [{ startMs: nowMs - 20 * 24 * HOUR, endMs: nowMs }],
    );
    expect([...new Set(hours.map((stat) => stat.hour))]).toEqual([
      "2031-07-06T12:00:00.000Z",
    ]);
  });
});
