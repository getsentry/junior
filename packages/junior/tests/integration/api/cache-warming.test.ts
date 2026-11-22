import { expectNoFullScan, expectSqlBudget } from "../../fixtures/sql-budget";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import {
  cacheHealthReportSchema,
  cacheWarmingBreakerListSchema,
  cacheWarmingSavingsReportSchema,
} from "@/api/schema";
import { connectedState } from "@/chat/cache-warming/request";
import {
  addHistoryPeriod,
  addHistoryWarmupCost,
  recordIdlePeriodSavings,
  recordWarmupCost,
  replaceHistorySavings,
  type HistorySavings,
} from "@/chat/cache-warming/savings";
import { botConfig } from "@/chat/config";
import { closeDb, getDb } from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import { mswServer } from "../../msw/server";

const BASE_URL = "https://junior.example.com";
const ADMIN = "admin@example.com";
const PERSON = "person@example.com";
const OPEN_KEY = "junior:cache_warming:breaker:anthropic:open";
const OUTCOMES_KEY = "junior:cache_warming:breaker:anthropic:outcomes";
const HEALTH_KEY = "junior:cache_warming:health:24h";
const SENTRY_EVENTS =
  "https://us.sentry.io/api/0/organizations/acme/:endpoint/";
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Fake the events API of Sentry's region host, with the answers of Junior's
 * own telemetry in the DSN project. `status` makes every read fail with it.
 */
function fakeSentryEvents(options: { status?: number } = {}) {
  const reads: URL[] = [];
  const start = Date.parse("2031-05-09T07:00:00.000Z");
  const timeSeries = (yAxis: string, first: number, second: number) => ({
    yAxis,
    values: [
      { timestamp: start, value: first, incomplete: false },
      { timestamp: start + HOUR_MS, value: second, incomplete: false },
    ],
    meta: {},
  });
  const tables: Record<string, Array<Record<string, unknown>>> = {
    "span.op:cache_warming.warmup": [
      {
        "app.cache_warming.trigger": "idle",
        "app.cache_warming.outcome": "completed",
        "app.cache_warming.turn_ending": "reply",
        "app.cache_warming.skip_reason": null,
        "count()": 30,
        "sum(tags[app.cost.total_usd,number])": 1.5,
      },
      {
        "app.cache_warming.trigger": "tool_wait",
        "app.cache_warming.outcome": "missed",
        "app.cache_warming.turn_ending": null,
        "app.cache_warming.skip_reason": null,
        "count()": 2,
        "sum(tags[app.cost.total_usd,number])": 0.25,
      },
      {
        "app.cache_warming.trigger": "idle",
        "app.cache_warming.outcome": "skipped",
        "app.cache_warming.turn_ending": "no_reply",
        "app.cache_warming.skip_reason": "unlikely_return",
        "count()": 9,
        "sum(tags[app.cost.total_usd,number])": null,
      },
    ],
  };
  mswServer.use(
    http.get(SENTRY_EVENTS, ({ request, params }) => {
      const url = new URL(request.url);
      reads.push(url);
      if (request.headers.get("authorization") !== "Bearer sntrys_read") {
        return new HttpResponse(null, { status: 401 });
      }
      if (options.status)
        return new HttpResponse(null, { status: options.status });
      const query = url.searchParams.get("query") ?? "";
      const fields = url.searchParams.getAll("field");
      if (params["endpoint"] === "events-timeseries") {
        if (query.includes("cache_creation.input_tokens:>50000")) {
          return HttpResponse.json({
            timeSeries: [timeSeries("count()", 1, 3)],
          });
        }
        // Sentry may order the series of a multi-axis read in any way.
        return HttpResponse.json({
          timeSeries: [
            timeSeries(
              "sum(gen_ai.usage.cache_creation.input_tokens)",
              50_000,
              400_000,
            ),
            timeSeries("count()", 10, 20),
            timeSeries("sum(gen_ai.usage.input_tokens)", 1_000_000, 2_000_000),
          ],
        });
      }
      if (fields.includes("app.cache_warming.idle_outcome")) {
        const metric = "cache_warming.idle_period.saved_usd,distribution,none";
        return HttpResponse.json({
          data: [
            {
              "app.cache_warming.idle_outcome": "saved",
              [`count(value,${metric})`]: 12,
              [`sum(value,${metric})`]: 3.6,
            },
            {
              "app.cache_warming.idle_outcome": "stopped_early",
              [`count(value,${metric})`]: 4,
              [`sum(value,${metric})`]: 0,
            },
          ],
        });
      }
      if (fields.includes("app.cache_warming.breaker_event")) {
        return HttpResponse.json({
          data: [
            {
              "app.cache_warming.breaker_event": "opened",
              "sum(value,cache_warming.breaker,counter,none)": 1,
            },
          ],
        });
      }
      return HttpResponse.json({
        data: tables[query] ?? [
          {
            "count()": 40,
            "sum(gen_ai.usage.input_tokens)": 4_000_000,
            "sum(gen_ai.usage.cache_creation.input_tokens)": 80_000,
          },
        ],
      });
    }),
  );
  return { reads };
}

async function readHealth(app: Awaited<ReturnType<typeof authenticatedApi>>) {
  const response = await app.request(`${BASE_URL}/api/cache-warming/health`);
  expect(response.status).toBe(200);
  return cacheHealthReportSchema.parse(await response.json());
}

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
    await state.delete(HEALTH_KEY);
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("lets an admin turn warming back on after the breaker opens", async () => {
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
    const person = await authenticatedApi(PERSON);
    vi.setSystemTime(new Date("2031-05-09T08:00:00.000Z"));
    await recordIdlePeriodSavings(
      "anthropic/claude-opus-5.5",
      { hit: true, oracleUsd: 0.8, savedUsd: 1 },
      { warmed: true, outcome: "saved" },
    );
    await recordWarmupCost("anthropic/claude-opus-5.5", 0.3);
    vi.setSystemTime(new Date("2031-05-10T20:00:00.000Z"));
    await recordIdlePeriodSavings(
      "anthropic/claude-opus-5.5",
      { hit: false, oracleUsd: 0.2, savedUsd: 0 },
      { warmed: false, outcome: "not_warmed" },
    );
    await recordWarmupCost("anthropic/claude-opus-5.5", 0.1);
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

  it("reads cache health from Junior's own Sentry project, once a minute", async () => {
    const person = await authenticatedApi(PERSON);
    // The panel names what to set until Junior can read its telemetry.
    vi.stubEnv("SENTRY_DSN", "");
    vi.stubEnv("SENTRY_ORG_SLUG", "acme");
    vi.stubEnv("SENTRY_READ_TOKEN", "");
    expect(await readHealth(person)).toEqual({
      status: "unconfigured",
      missing: ["SENTRY_DSN", "SENTRY_READ_TOKEN"],
    });

    vi.stubEnv("SENTRY_DSN", "https://key@o42.ingest.us.sentry.io/4242");
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_read");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-05-09T08:30:00.000Z"));
    const sentry = fakeSentryEvents();
    const report = await readHealth(person);
    // Every read is of the DSN project, in the configured org.
    expect(sentry.reads).toHaveLength(6);
    expect(
      new Set(sentry.reads.map((url) => url.searchParams.get("project"))),
    ).toEqual(new Set(["4242"]));
    expect(sentry.reads[0]?.searchParams.get("query")).toBe(
      `span.op:gen_ai.chat !has:gen_ai.prompt.name gen_ai.request.model:"${botConfig.modelId}"`,
    );
    expect(report).toMatchObject({
      status: "ok",
      window: "24h",
      stale: false,
      buckets: [
        {
          start: "2031-05-09T07",
          calls: 10,
          inputTokens: 1_000_000,
          cacheWriteTokens: 50_000,
          fullRewrites: 1,
        },
        {
          start: "2031-05-09T08",
          calls: 20,
          inputTokens: 2_000_000,
          cacheWriteTokens: 400_000,
          fullRewrites: 3,
        },
      ],
      lastWeek: { calls: 40, inputTokens: 4_000_000, cacheWriteTokens: 80_000 },
      warmups: {
        sentByTurnEnding: { reply: 30, tool_wait: 2 },
        skipReasons: { unlikely_return: 9 },
        costUsd: expect.closeTo(1.75),
      },
      idlePeriods: {
        saved: 12,
        notWarmed: 0,
        stoppedEarly: 4,
        cacheLost: 0,
        savedUsd: expect.closeTo(3.6),
      },
      breakers: [{ provider: "anthropic", open: false }],
      breakerEvents: { opened: 1, closed: 0 },
    });
    // The last week read covers the same 24 hours, a week earlier.
    expect(sentry.reads[2]?.searchParams.get("start")).toBe(
      "2031-05-01T08:30:00.000Z",
    );

    // Loads within a minute share the answer, but the breaker state is live.
    const state = await connectedState();
    await state.set(OPEN_KEY, true, 60_000);
    vi.setSystemTime(new Date("2031-05-09T08:30:59.000Z"));
    expect(await readHealth(person)).toMatchObject({
      breakers: [{ provider: "anthropic", open: true }],
      stale: false,
    });
    expect(sentry.reads).toHaveLength(6);

    // Loads that find the answer old together share one refresh.
    vi.setSystemTime(new Date("2031-05-09T08:31:10.000Z"));
    await Promise.all([readHealth(person), readHealth(person)]);
    expect(sentry.reads).toHaveLength(12);

    // A rate limited read serves the last answer, marked stale, and stops
    // the reads that have not started.
    mswServer.resetHandlers();
    const limited = fakeSentryEvents({ status: 429 });
    vi.setSystemTime(new Date("2031-05-09T08:32:30.000Z"));
    expect(await readHealth(person)).toMatchObject({
      status: "ok",
      stale: true,
      fetchedAt: "2031-05-09T08:31:10.000Z",
    });
    expect(limited.reads).toHaveLength(2);

    // A token that Sentry rejects is reported, not served from the cache.
    vi.stubEnv("SENTRY_READ_TOKEN", "sntrys_revoked");
    expect(await readHealth(person)).toEqual({ status: "denied" });
  });
});
