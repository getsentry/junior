import type { User } from "@sentry/junior-plugin-api";
import { sentryPlugin } from "@sentry/junior-sentry";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { closeDb } from "@/chat/db";
import { defineJuniorPlugins } from "@/plugins";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const SENTRY_SCOPE =
  "alerts:write event:write member:read org:read project:releases project:write team:write";
const ORG_READ_TOKEN = "org-read-token";
const REGION = "https://us.sentry.io";

const field = (value: Record<string, unknown>) => JSON.stringify(value);

const EXPLORE_URL = (() => {
  const url = new URL("https://sentry.sentry.io/explore/traces/");
  url.searchParams.append("aggregateField", field({ groupBy: "span.op" }));
  url.searchParams.append(
    "aggregateField",
    field({ chartType: 1, yAxes: ["p95(span.duration)"] }),
  );
  url.searchParams.append("project", "11");
  url.searchParams.append("statsPeriod", "24h");
  return url.href;
})();

// Each series: `[group, points]`. Sentry lists the top groups by `order`.
function timeSeries(groups: Array<[string | null, Array<number | null>]>) {
  return {
    timeSeries: groups.map(([group, points], order) => ({
      yAxis: "p95(span.duration)",
      groupBy: [{ key: "span.op", value: group }],
      meta: {
        interval: 300_000,
        order,
        valueType: "duration",
        valueUnit: "ms",
      },
      values: points.map((value, index) => ({
        incomplete: false,
        timestamp: 1782896400000 + index * 300_000,
        value,
      })),
    })),
  };
}

/**
 * Fake Sentry's org and events-timeseries APIs.
 * A viewer token sees a project only when `projects` lists it for that
 * viewer. Like Sentry, a query over a project the token cannot see is 403.
 */
function fakeSentry(
  projects: Record<string, string[]>,
  body: Record<string, unknown> = timeSeries([
    ["http.client", [12, 30.12345, 18]],
    [null, [4, 5, 6]],
  ]),
) {
  const queries: string[] = [];
  const canSee = (request: Request) => {
    const token = request.headers.get("authorization") ?? "none";
    const viewer = token.replace(/^Bearer (.+)-token$/, "$1");
    const asked = new URL(request.url).searchParams.getAll("project");
    return (
      token !== `Bearer ${ORG_READ_TOKEN}` &&
      asked.every((project) => projects[viewer]?.includes(project))
    );
  };
  const record = (request: Request) => {
    const url = new URL(request.url);
    queries.push(
      `${request.headers.get("authorization")} ${url.host}${url.pathname}?${url.searchParams}`,
    );
  };
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) =>
      HttpResponse.json({ slug: params["org"], links: { regionUrl: REGION } }),
    ),
    http.get(
      `${REGION}/api/0/organizations/sentry/events-timeseries/`,
      ({ request }) => {
        record(request);
        return canSee(request)
          ? HttpResponse.json(body)
          : new HttpResponse(null, { status: 403 });
      },
    ),
  );
  return { queries };
}

async function connectSentry(viewer: User, name: string) {
  await createUserTokenStore().set(viewer.id, "sentry", {
    accessToken: `${name}-token`,
    expiresAt: Date.now() + 3_600_000,
    refreshToken: `${name}-refresh`,
    scope: SENTRY_SCOPE,
  });
}

async function readCards(viewer: User, urls: string[]) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const query = new URLSearchParams(urls.map((url) => ["url", url]));
  const response = await app.request(`http://localhost/api/objects?${query}`);
  expect(response.status).toBe(200);
  const body = await response.text();
  return {
    body,
    objects: objectLinksReportSchema.parse(JSON.parse(body)).objects,
  };
}

describe("Sentry chart link cards", () => {
  beforeEach(async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", ORG_READ_TOKEN);
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([sentryPlugin()]),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("draws an Explore chart from the viewer's own query", async () => {
    const { queries } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [EXPLORE_URL]);

    expect(objects).toEqual([
      {
        url: EXPLORE_URL,
        object: {
          kind: "object",
          objectType: "chart",
          plugin: "sentry",
          key: expect.stringMatching(/^chart:[0-9a-f]{32}$/),
          label: "Explore traces",
          title: "p95(span.duration) by span.op",
          url: EXPLORE_URL,
          displayType: "Explore traces",
          facts: {
            type: "chart",
            display: "line",
            yAxis: "p95(span.duration)",
            range: "Last 24 hours",
            series: [
              { label: "http.client", points: [12, 30.1, 18] },
              { label: "(no value)", points: [4, 5, 6] },
            ],
          },
        },
      },
    ]);
    // Alice's own token runs the Explore chart query on the region host.
    // Junior's org read token reads no chart data.
    expect(queries).toEqual([
      `Bearer alice-token us.sentry.io/api/0/organizations/sentry/events-timeseries/?${new URLSearchParams(
        [
          ["dataset", "spans"],
          ["interval", "5m"],
          ["yAxis", "p95(span.duration)"],
          ["groupBy", "span.op"],
          ["project", "11"],
          ["sort", "-p95(span.duration)"],
          ["topEvents", "5"],
          ["statsPeriod", "24h"],
        ],
      )}`,
    ]);
  });

  it("shows nothing of a chart to a viewer who cannot see its projects", async () => {
    const { queries } = fakeSentry({ alice: ["11"], bob: ["12"] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached chart must not reach Bob.
    await readCards(alice, [EXPLORE_URL]);
    const { body, objects } = await readCards(bob, [EXPLORE_URL]);

    expect(objects).toEqual([]);
    for (const text of ["http.client", "p95(span.duration)", "30.1"]) {
      expect(body).not.toContain(text);
    }
    // Only Bob's own token asks for him. Egress retries a 403 once.
    expect(new Set(queries.map((query) => query.split(" ")[1]))).toEqual(
      new Set(["alice-token", "bob-token"]),
    );
  });

  it("shows no chart to a viewer who has not connected Sentry", async () => {
    const { queries } = fakeSentry({ alice: ["11"], carol: ["11"] });
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readCards(testViewer("carol@example.com"), [
      EXPLORE_URL,
    ]);

    expect(objects).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("runs each viewer's chart query once a minute", async () => {
    const { queries } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    await readCards(alice, [EXPLORE_URL]);
    const { objects } = await readCards(alice, [EXPLORE_URL]);

    expect(objects).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });

  it("draws across empty buckets and names a custom range in UTC", async () => {
    // Sentry writes custom bounds in UTC without a zone. Junior's own zone
    // must not shift them.
    vi.stubEnv("TZ", "America/New_York");
    const { queries } = fakeSentry(
      { alice: ["11"] },
      timeSeries([["http.client", [null, 12, null, 18, null]]]),
    );
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = new URL(EXPLORE_URL);
    url.searchParams.delete("statsPeriod");
    url.searchParams.set("start", "2026-11-13T00:00:00");
    url.searchParams.set("end", "2026-11-13T12:00:00");

    const { objects } = await readCards(alice, [url.href]);

    expect(objects[0]?.object.facts).toMatchObject({
      range: "2026-11-13 00:00 to 2026-11-13 12:00 UTC",
      // A bucket with no samples is not a zero.
      series: [{ label: "http.client", points: [12, 12, 15, 18, 18] }],
    });
    const sent = new URLSearchParams(queries[0]!.split("?")[1]);
    expect([sent.get("start"), sent.get("end")]).toEqual([
      "2026-11-13T00:00:00.000Z",
      "2026-11-13T12:00:00.000Z",
    ]);
  });

  it("names the aggregate of each group when a chart has two", async () => {
    const series = (yAxis: string, group: string, order: number) => ({
      yAxis,
      groupBy: [{ key: "span.op", value: group }],
      meta: { interval: 300_000, order },
      values: [1, 2].map((value, index) => ({
        timestamp: 1782896400000 + index * 300_000,
        value,
      })),
    });
    fakeSentry(
      { alice: ["11"] },
      {
        timeSeries: [
          series("p95(span.duration)", "http.client", 0),
          series("count(span.duration)", "http.client", 0),
          series("p95(span.duration)", "db", 1),
          series("count(span.duration)", "db", 1),
        ],
      },
    );
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = new URL(EXPLORE_URL);
    url.searchParams.set(
      "aggregateField",
      field({
        chartType: 1,
        yAxes: ["p95(span.duration)", "count(span.duration)"],
      }),
    );
    url.searchParams.append("aggregateField", field({ groupBy: "span.op" }));

    const { objects } = await readCards(alice, [url.href]);

    const facts = objects[0]?.object.facts;
    expect(facts?.type === "chart" && facts.series.map((s) => s.label)).toEqual(
      [
        "http.client · p95(span.duration)",
        "http.client · count(span.duration)",
        "db · p95(span.duration)",
        "db · count(span.duration)",
      ],
    );
  });

  it("fits long series in the card facts limit", async () => {
    const points = Array.from({ length: 1000 }, (_, index) => 1000 + index / 7);
    fakeSentry(
      { alice: ["11"] },
      timeSeries(
        ["a", "b", "c", "d", "e", "f"].map((group) => [group, points]),
      ),
    );
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [EXPLORE_URL]);

    const facts = objects[0]?.object.facts;
    if (facts?.type !== "chart") throw new Error("Expected a chart card");
    expect(facts.series.map((series) => series.label)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    expect(
      new Set(facts.series.map((series) => series.points.length)).size,
    ).toBe(1);
    expect(facts.series[0]!.points.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(facts).length).toBeLessThanOrEqual(4096);
  });
});
