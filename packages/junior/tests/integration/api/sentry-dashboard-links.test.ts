import type { User } from "@sentry/junior-plugin-api";
import { sentryPlugin } from "@sentry/junior-sentry";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { closeDb } from "@/chat/db";
import { defineJuniorPlugins } from "@/plugins";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";
import { readLiveCards } from "../../fixtures/object-cards";

const SENTRY_SCOPE =
  "alerts:write event:write member:read org:read project:releases project:write team:write";
const ORG_READ_TOKEN = "org-read-token";
const REGION = "https://us.sentry.io";
const API = `${REGION}/api/0/organizations/sentry`;

const DASHBOARD_URL = "https://sentry.sentry.io/dashboard/42/";

function widget(
  title: string,
  widgetType: string,
  displayType: string,
  query: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    id: title,
    title,
    widgetType,
    displayType,
    interval: "5m",
    limit: null,
    queries: [
      {
        aggregates: ["count()"],
        columns: [],
        conditions: "",
        orderby: "",
        isHidden: false,
        ...query,
      },
    ],
    ...extra,
  };
}

const CHECKOUT_DASHBOARD = {
  id: "42",
  title: "Checkout health",
  projects: [11],
  environment: ["production"],
  period: "24h",
  filters: {
    release: ["checkout@4.2.0"],
    globalFilter: [
      {
        dataset: "spans",
        tag: { key: "span.op", name: "span.op" },
        value: "span.op:http.client",
      },
    ],
  },
  createdBy: { email: "owner@example.com" },
  widgets: [
    widget("Checkout p95", "spans", "line", {
      aggregates: ["p95(span.duration)"],
      conditions: "transaction:/checkout",
    }),
    // Discover-backed and table widgets are never queried.
    widget("Errors by release", "error-events", "line"),
    widget("Slow spans", "spans", "table"),
    widget(
      "Log volume",
      "logs",
      "bar",
      {
        aggregates: ["count(message)"],
        columns: ["severity"],
        orderby: "-count(message)",
      },
      { limit: 3 },
    ),
    widget("Token usage", "tracemetrics", "area", {
      aggregates: ["sum(value)"],
    }),
    widget("Checkout p50", "spans", "line", {
      aggregates: ["p50(span.duration)"],
    }),
  ],
};

/**
 * Fake Sentry's org, dashboard, project, and events-timeseries APIs. A
 * token reads the dashboard only when `access` lists its viewer, and it
 * then sees the projects that `access` lists. Like Sentry, a chart query
 * over a project that the token cannot see is 403. Junior's org read token
 * reads no dashboard.
 */
function fakeSentry(access: Record<string, string[]>) {
  const requests: Array<{
    token: string;
    path: string;
    params: URLSearchParams;
  }> = [];
  const viewerOf = (request: Request) => {
    const url = new URL(request.url);
    const token = request.headers.get("authorization") ?? "none";
    requests.push({ token, path: url.pathname, params: url.searchParams });
    return access[token.replace(/^Bearer (.+)-token$/, "$1")];
  };
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) =>
      HttpResponse.json({ slug: params["org"], links: { regionUrl: REGION } }),
    ),
    http.get(`${API}/dashboards/:id/`, ({ params, request }) =>
      viewerOf(request) && params["id"] === "42"
        ? HttpResponse.json(CHECKOUT_DASHBOARD)
        : HttpResponse.json({ detail: "Not found" }, { status: 404 }),
    ),
    http.get(`${API}/projects/`, ({ request }) => {
      const projects = viewerOf(request) ?? [];
      const ids = (new URL(request.url).searchParams.get("query") ?? "")
        .split(" ")
        .map((token) => token.replace(/^id:/, ""));
      const all = [
        { id: "11", slug: "checkout" },
        { id: "12", slug: "payments" },
      ];
      return HttpResponse.json(
        all.filter(({ id }) => ids.includes(id) && projects.includes(id)),
      );
    }),
    http.get(`${API}/events-timeseries/`, ({ request }) => {
      const projects = viewerOf(request);
      const params = new URL(request.url).searchParams;
      if (
        !projects ||
        !params.getAll("project").every((id) => projects.includes(id))
      ) {
        return new HttpResponse(null, { status: 403 });
      }
      const yAxis = params.get("yAxis")!;
      const groups = params.has("groupBy") ? ["error", "info"] : [null];
      return HttpResponse.json({
        timeSeries: groups.map((group, order) => ({
          yAxis,
          groupBy: group ? [{ key: "severity", value: group }] : null,
          meta: { order },
          values: [3, 7.12345, 5].map((value, index) => ({
            timestamp: 1782896400000 + index * 300_000,
            value: value + order,
          })),
        })),
      });
    }),
  );
  return { requests };
}

async function connectSentry(viewer: User, name: string) {
  await createUserTokenStore().set(viewer.id, "sentry", {
    accessToken: `${name}-token`,
    expiresAt: Date.now() + 3_600_000,
    refreshToken: `${name}-refresh`,
    scope: SENTRY_SCOPE,
  });
}

const chartQueries = (requests: ReturnType<typeof fakeSentry>["requests"]) =>
  requests
    .filter(({ path }) => path.endsWith("/events-timeseries/"))
    .map(({ token, params }) => ({ token, ...Object.fromEntries(params) }));

describe("Sentry dashboard link cards", () => {
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

  it("draws a dashboard card with charts from the viewer's own reads", async () => {
    const { requests } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { body, objects } = await readLiveCards(alice, [DASHBOARD_URL]);

    expect(objects).toEqual([
      {
        url: DASHBOARD_URL,
        object: {
          kind: "object",
          objectType: "dashboard",
          plugin: "sentry",
          key: expect.stringMatching(/^dashboard:sentry:42:[0-9a-f]{16}$/),
          label: "Sentry dashboard",
          title: "Checkout health",
          url: DASHBOARD_URL,
          displayType: "Sentry dashboard",
          facts: {
            type: "dashboard",
            widgetCount: 6,
            projects: ["checkout"],
            environments: ["production"],
            range: "Last 24 hours",
            widgets: [
              { title: "Checkout p95", display: "Line chart" },
              { title: "Errors by release", display: "Line chart" },
              { title: "Slow spans", display: "Table" },
              { title: "Log volume", display: "Bar chart" },
              { title: "Token usage", display: "Area chart" },
              { title: "Checkout p50", display: "Line chart" },
            ],
            charts: [
              {
                title: "Checkout p95",
                display: "line",
                series: [{ label: "p95(span.duration)", points: [3, 7.12, 5] }],
              },
              {
                title: "Log volume",
                display: "bar",
                series: [
                  { label: "error", points: [3, 7.12, 5] },
                  { label: "info", points: [4, 8.12, 6] },
                ],
              },
              {
                title: "Token usage",
                display: "area",
                series: [{ label: "sum(value)", points: [3, 7.12, 5] }],
              },
            ],
          },
        },
      },
    ]);
    expect(body).not.toContain("owner@example.com");
    // Alice's own token reads everything on the region host. Junior's org
    // read token reads nothing there.
    expect(new Set(requests.map(({ token }) => token))).toEqual(
      new Set(["Bearer alice-token"]),
    );
    // One query each for the first three charts that a card can draw, with
    // the dashboard filters. No Discover-backed widget is queried.
    expect(chartQueries(requests)).toEqual([
      {
        token: "Bearer alice-token",
        dataset: "spans",
        interval: "5m",
        yAxis: "p95(span.duration)",
        project: "11",
        environment: "production",
        query:
          '(transaction:/checkout) release:"checkout@4.2.0" span.op:http.client',
        statsPeriod: "24h",
      },
      {
        token: "Bearer alice-token",
        dataset: "logs",
        interval: "5m",
        yAxis: "count(message)",
        groupBy: "severity",
        project: "11",
        environment: "production",
        query: 'release:"checkout@4.2.0"',
        sort: "-count(message)",
        topEvents: "3",
        statsPeriod: "24h",
      },
      {
        token: "Bearer alice-token",
        dataset: "tracemetrics",
        interval: "5m",
        yAxis: "sum(value)",
        project: "11",
        environment: "production",
        query: 'release:"checkout@4.2.0"',
        statsPeriod: "24h",
      },
    ]);
  });

  it("uses the page filters of the URL over the saved ones", async () => {
    const { requests } = fakeSentry({ alice: ["11", "12"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = `${DASHBOARD_URL}?project=12&environment=staging&statsPeriod=7d`;

    const { objects } = await readLiveCards(alice, [url]);

    expect(objects[0]?.object.facts).toMatchObject({
      projects: ["payments"],
      environments: ["staging"],
      range: "Last 7 days",
    });
    expect(chartQueries(requests)[0]).toMatchObject({
      project: "12",
      environment: "staging",
      statsPeriod: "7d",
      // A 5 minute interval is too fine for 7 days.
      interval: "30m",
    });
  });

  it("draws a widget link as a chart card", async () => {
    const { requests } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = "https://sentry.io/organizations/sentry/dashboard/42/widget/3/";

    const { objects } = await readLiveCards(alice, [url]);

    expect(objects).toEqual([
      {
        url,
        object: {
          kind: "object",
          objectType: "chart",
          plugin: "sentry",
          key: expect.stringMatching(/^chart:[0-9a-f]{32}$/),
          label: "Dashboard widget",
          title: "Log volume",
          url,
          displayType: "Dashboard widget",
          facts: {
            type: "chart",
            summary: 'release:"checkout@4.2.0"',
            display: "bar",
            yAxis: "count(message)",
            range: "Last 24 hours",
            series: [
              { label: "error", points: [3, 7.12, 5] },
              { label: "info", points: [4, 8.12, 6] },
            ],
          },
        },
      },
    ]);
    expect(chartQueries(requests)).toHaveLength(1);
  });

  it("shows no card for a widget that reads Discover", async () => {
    const { requests } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readLiveCards(alice, [
      `${DASHBOARD_URL}widget/1/`,
      `${DASHBOARD_URL}widget/2/`,
      `${DASHBOARD_URL}widget/99/`,
    ]);

    expect(objects).toEqual([]);
    expect(chartQueries(requests)).toEqual([]);
  });

  it("shows nothing of a dashboard to a viewer who cannot read it", async () => {
    const { requests } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached dashboard and widget must not reach Bob.
    const urls = [DASHBOARD_URL, `${DASHBOARD_URL}widget/0/`];
    expect((await readLiveCards(alice, urls)).objects).toHaveLength(2);
    const { body, objects } = await readLiveCards(bob, urls);

    expect(objects).toEqual([]);
    for (const text of ["Checkout health", "checkout@4.2.0", "Log volume"]) {
      expect(body).not.toContain(text);
    }
    expect(
      requests.filter(({ token }) => token === "Bearer bob-token"),
    ).toHaveLength(2);
  });

  it("shows no dashboard to a viewer who has not connected Sentry", async () => {
    const { requests } = fakeSentry({ alice: ["11"], carol: ["11"] });
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readLiveCards(testViewer("carol@example.com"), [
      DASHBOARD_URL,
    ]);

    expect(objects).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads each viewer's dashboard once a minute", async () => {
    const { requests } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    await readLiveCards(alice, [DASHBOARD_URL]);
    const { objects } = await readLiveCards(alice, [DASHBOARD_URL]);

    expect(objects).toHaveLength(1);
    // The dashboard, its projects, and three charts, read once.
    expect(requests).toHaveLength(5);
  });
});
