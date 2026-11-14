import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  cacheWarmingBreakerListSchema,
  cacheWarmingSavingsReportSchema,
} from "@/api/schema";
import { connectedState } from "@/chat/cache-warming/request";
import {
  addHistoryPeriod,
  recordIdlePeriodSavings,
  recordWarmupCost,
  replaceHistorySavings,
  type HistorySavings,
} from "@/chat/cache-warming/savings";
import { closeDb, getDb } from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";

const BASE_URL = "https://junior.example.com";
const ADMIN = "admin@example.com";
const PERSON = "person@example.com";
const OPEN_KEY = "junior:cache_warming:breaker:anthropic:open";
const OUTCOMES_KEY = "junior:cache_warming:breaker:anthropic:outcomes";

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`missing viewer for ${email}`);
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function listBreakers(app: ReturnType<typeof authenticatedApi>) {
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
    await closeDb();
  });

  it("lets an admin turn warming back on after the breaker opens", async () => {
    const state = await connectedState();
    await state.set(OPEN_KEY, true, 60_000);
    await state.appendToList(OUTCOMES_KEY, 1, { maxLength: 20 });
    const admin = authenticatedApi(ADMIN);
    const person = authenticatedApi(PERSON);

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
      { provider: "anthropic", open: false },
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
    const person = authenticatedApi(PERSON);
    vi.setSystemTime(new Date("2031-05-09T08:00:00.000Z"));
    await recordIdlePeriodSavings(
      "anthropic/claude-opus-5.5",
      { hit: true, oracleUsd: 0.8, savedUsd: 1 },
      true,
    );
    await recordWarmupCost("anthropic/claude-opus-5.5", 0.3);
    vi.setSystemTime(new Date("2031-05-10T20:00:00.000Z"));
    await recordIdlePeriodSavings(
      "anthropic/claude-opus-5.5",
      { hit: false, oracleUsd: 0.2, savedUsd: 0 },
      false,
    );
    await recordWarmupCost("anthropic/claude-opus-5.5", 0.1);
    // A day from history has no warmup cost, so net savings and
    // effectiveness leave it out.
    const history: HistorySavings = {};
    addHistoryPeriod(
      history,
      Date.parse("2031-05-08T12:00:00.000Z"),
      "anthropic/claude-opus-5.5",
      { hit: true, oracleUsd: 2, savedUsd: 3 },
    );
    await replaceHistorySavings(history, {
      start: "2031-05-08",
      end: "2031-05-09",
    });

    const response = await person.request(
      `${BASE_URL}/api/cache-warming/savings?days=7`,
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
      savedUsd: expect.closeTo(3),
      netSavingsUsd: null,
    });
    expect(report.days.at(-1)).toMatchObject({
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
      warmupCostUsd: expect.closeTo(0.4),
      netSavingsUsd: expect.closeTo(0.6),
      oracleSavingsUsd: expect.closeTo(3),
      knownCostOracleSavingsUsd: expect.closeTo(1),
      effectiveness: expect.closeTo(0.6),
      unknownCostDays: 1,
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
});
