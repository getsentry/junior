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
const ORG_API = `${REGION}/api/0/organizations/sentry`;

const LATENCY_URL = "https://sentry.sentry.io/monitors/101/";

const CHECKOUT_PROJECT = { id: "11", slug: "checkout", name: "Checkout" };
const NIGHTLY_CRON = {
  id: "c1",
  slug: "nightly-export",
  name: "Nightly export",
  status: "active",
  isMuted: false,
  config: { schedule_type: "crontab", schedule: "0 3 * * *" },
  project: CHECKOUT_PROJECT,
  environments: [
    {
      name: "production",
      status: "error",
      isMuted: false,
      lastCheckIn: "2026-11-14T03:00:12Z",
    },
    {
      name: "staging",
      status: "ok",
      isMuted: false,
      lastCheckIn: "2026-11-14T03:00:05Z",
    },
  ],
};

function detector(id: string, fields: Record<string, unknown>) {
  return {
    id,
    projectId: "11",
    enabled: true,
    description: null,
    latestGroup: null,
    workflowIds: [],
    dateCreated: "2026-01-01T00:00:00Z",
    dateUpdated: "2026-01-01T00:00:00Z",
    ...fields,
  };
}

function snubaSource(dataset: string, eventTypes: string[]) {
  return {
    type: "snuba_query_subscription",
    queryObj: {
      id: "q1",
      status: 0,
      subscription: "s1",
      snubaQuery: {
        id: "sq1",
        dataset,
        query: "transaction:/checkout",
        aggregate: "p95(span.duration)",
        timeWindow: 300,
        environment: "production",
        eventTypes,
      },
    },
  };
}

const DETECTORS: Record<string, unknown> = {
  "101": detector("101", {
    name: "Checkout latency",
    type: "metric_issue",
    description: "Pages when checkout gets slow.",
    latestGroup: {
      id: "9001",
      status: "unresolved",
      project: { id: "11", slug: "checkout" },
    },
    dataSources: [
      snubaSource("events_analytics_platform", ["trace_item_span"]),
    ],
  }),
  "102": detector("102", {
    name: "Nightly export",
    type: "monitor_check_in_failure",
    dataSources: [{ type: "cron_monitor", queryObj: NIGHTLY_CRON }],
  }),
  "103": detector("103", {
    name: "Checkout API",
    type: "uptime_domain_failure",
    config: { environment: "production" },
    latestGroup: {
      id: "9002",
      status: "resolved",
      project: { id: "11", slug: "checkout" },
    },
    dataSources: [
      {
        type: "uptime_subscription",
        queryObj: {
          url: "https://api.example.com/health?token=secret-value",
          method: "GET",
          intervalSeconds: 60,
        },
      },
    ],
  }),
  "104": detector("104", {
    name: "Checkout errors",
    type: "metric_issue",
    dataSources: [snubaSource("events", ["error"])],
  }),
  "105": detector("105", { name: "Error monitor", type: "error" }),
  "201": detector("201", { name: "Issue stream", type: "issue_stream" }),
};

const ALERT_URL = "https://sentry.sentry.io/monitors/alerts/301/";
const WORKFLOWS: Record<string, unknown> = {
  "301": {
    id: "301",
    name: "New UI feedback",
    type: "alert",
    organizationId: "1",
    createdBy: "7",
    dateCreated: "2026-11-17T09:00:00Z",
    dateUpdated: "2026-11-17T09:00:00Z",
    enabled: true,
    environment: null,
    config: { frequency: 30 },
    detectorIds: ["201"],
    lastTriggered: "2026-11-17T09:30:00Z",
    triggers: {
      logicType: "any-short",
      conditions: [{ id: "1", type: "first_seen_event", comparison: true }],
    },
    actionFilters: [
      {
        logicType: "all",
        conditions: [
          { id: "2", type: "issue_category", comparison: { value: 6 } },
          {
            id: "3",
            type: "tagged_event",
            comparison: {
              key: "app.feedback.topic",
              match: "eq",
              value: "new_ui",
            },
          },
        ],
        actions: [
          {
            id: "4",
            type: "email",
            config: { targetType: "user", targetIdentifier: "7" },
          },
          {
            id: "5",
            type: "slack",
            config: {
              targetType: "specific",
              targetIdentifier: "U7",
              targetDisplay: "@burak.kaya",
            },
          },
          {
            id: "6",
            type: "webhook",
            config: {
              targetType: "specific",
              targetDisplay: "ops@example.com",
            },
          },
        ],
      },
    ],
  },
};

/**
 * Fake Sentry's org, monitor, alert, check-in, project, and timeseries APIs.
 * Like Sentry, a token reads monitors only in the projects that `projects`
 * lists for its viewer, and Junior's org read token reads none.
 */
function fakeSentry(projects: Record<string, string[]>) {
  const queries: string[] = [];
  const viewerOf = (request: Request) => {
    const token = request.headers.get("authorization") ?? "none";
    const url = new URL(request.url);
    queries.push(`${token} ${url.host}${url.pathname}${url.search}`);
    return token.replace(/^Bearer (.+)-token$/, "$1");
  };
  const canRead = (request: Request) =>
    projects[viewerOf(request)]?.includes("11") ?? false;
  const notFound = () =>
    HttpResponse.json({ detail: "Not found" }, { status: 404 });
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) =>
      HttpResponse.json({ slug: params["org"], links: { regionUrl: REGION } }),
    ),
    http.get(`${ORG_API}/detectors/:id/`, ({ params, request }) => {
      const found = DETECTORS[String(params["id"])];
      return found && canRead(request) ? HttpResponse.json(found) : notFound();
    }),
    http.get(`${ORG_API}/detectors/`, ({ request }) => {
      const ids = new URL(request.url).searchParams.getAll("id");
      return canRead(request)
        ? HttpResponse.json(ids.map((id) => DETECTORS[id]).filter(Boolean))
        : notFound();
    }),
    http.get(`${ORG_API}/workflows/:id/`, ({ params, request }) => {
      const found = WORKFLOWS[String(params["id"])];
      return found && canRead(request) ? HttpResponse.json(found) : notFound();
    }),
    http.get(`${ORG_API}/monitors/:slug/`, ({ params, request }) =>
      params["slug"] === NIGHTLY_CRON.slug && canRead(request)
        ? HttpResponse.json(NIGHTLY_CRON)
        : notFound(),
    ),
    http.get(`${ORG_API}/monitors/:slug/checkins/`, ({ request }) =>
      canRead(request)
        ? HttpResponse.json(
            // Newest first, as Sentry lists them.
            [4200, null, 3900].map((duration, index) => ({
              id: `k${index}`,
              environment: "production",
              status: duration === null ? "missed" : "ok",
              duration,
            })),
          )
        : notFound(),
    ),
    http.get(`${ORG_API}/projects/`, ({ request }) =>
      canRead(request) ? HttpResponse.json([CHECKOUT_PROJECT]) : notFound(),
    ),
    http.get(`${ORG_API}/events-timeseries/`, ({ request }) =>
      canRead(request)
        ? HttpResponse.json({
            timeSeries: [
              {
                yAxis: "p95(span.duration)",
                values: [
                  { value: null },
                  { value: 180 },
                  { value: null },
                  { value: 920 },
                ],
              },
            ],
          })
        : notFound(),
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

describe("Sentry monitor link cards", () => {
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

  it("draws a metric alert card with its trend from the viewer's own read", async () => {
    const { queries } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [LATENCY_URL]);

    expect(objects).toEqual([
      {
        url: LATENCY_URL,
        object: {
          kind: "object",
          objectType: "monitor",
          plugin: "sentry",
          key: "monitor:sentry:101",
          label: "Checkout latency",
          title: "Checkout latency",
          url: LATENCY_URL,
          status: "Alerting",
          displayType: "Sentry monitor",
          facts: {
            type: "monitor",
            summary: "Pages when checkout gets slow.",
            kind: "metric",
            state: "failing",
            project: "checkout",
            environment: "production",
            detail: "p95(span.duration) per 5 min",
            trend: {
              label: "p95(span.duration), last 4 h",
              points: [180, 180, 920],
            },
          },
        },
      },
    ]);
    // Alice's own token reads the monitor and its trend on the region
    // host, over 48 of its windows. Junior's org read token reads neither.
    const trend = new URL(
      `https://${queries.find((query) => query.includes("events-timeseries"))?.split(" ")[2]}`,
    ).searchParams;
    expect(Object.fromEntries(trend)).toEqual({
      dataset: "spans",
      yAxis: "p95(span.duration)",
      interval: "5m",
      statsPeriod: "240m",
      project: "11",
      environment: "production",
      query: "transaction:/checkout",
    });
    expect(
      queries.every((query) => query.startsWith("Bearer alice-token")),
    ).toBe(true);
    expect(queries).toHaveLength(2);
  });

  it("draws a cron job and an uptime check from each URL form", async () => {
    fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const urls = [
      "https://sentry.io/organizations/sentry/monitors/102/",
      "https://sentry.sentry.io/alerts/rules/crons/checkout/nightly-export/details/",
      "https://sentry.sentry.io/alerts/rules/uptime/checkout/103/details/",
    ];

    const { body, objects } = await readCards(alice, urls);

    const cron = {
      type: "monitor",
      kind: "cron",
      state: "failing",
      project: "checkout",
      environment: "production, staging",
      detail: "0 3 * * *",
      lastCheckedAt: "2026-11-14T03:00:12.000Z",
      trend: {
        label: "Run time (ms), last 3 check-ins",
        points: [3900, 3900, 4200],
      },
    };
    expect(
      objects.map(({ object }) => [object.key, object.status, object.facts]),
    ).toEqual([
      ["monitor:sentry:102", "Failing", cron],
      ["monitor:sentry:cron:nightly-export", "Failing", cron],
      [
        "monitor:sentry:103",
        "Up",
        {
          type: "monitor",
          kind: "uptime",
          state: "ok",
          project: "checkout",
          environment: "production",
          detail: "GET https://api.example.com/health",
        },
      ],
    ]);
    // An uptime URL's query string can hold a token.
    expect(body).not.toContain("secret-value");
  });

  it("draws no trend for a metric alert on a Discover dataset", async () => {
    const { queries } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [
      "https://sentry.sentry.io/monitors/104/",
    ]);

    expect(objects[0]?.object.status).toBe("OK");
    expect(objects[0]?.object.facts).not.toHaveProperty("trend");
    expect(queries.some((query) => query.includes("events-timeseries"))).toBe(
      false,
    );
  });

  it("shows no card for a monitor that checks no schedule", async () => {
    fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [
      "https://sentry.sentry.io/monitors/105/",
    ]);

    expect(objects).toEqual([]);
  });

  it("shows nothing of a monitor to a viewer who cannot see its project", async () => {
    const { queries } = fakeSentry({ alice: ["11"], bob: ["99"] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached monitor must not reach Bob.
    expect((await readCards(alice, [LATENCY_URL])).objects).toHaveLength(1);
    const { body, objects } = await readCards(bob, [LATENCY_URL]);

    expect(objects).toEqual([]);
    for (const text of ["Checkout latency", "p95(span.duration)", "Alerting"]) {
      expect(body).not.toContain(text);
    }
    expect(queries.filter((query) => query.includes("bob-token"))).toEqual([
      `Bearer bob-token us.sentry.io/api/0/organizations/sentry/detectors/101/`,
    ]);
  });

  it("shows no monitor to a viewer who has not connected Sentry", async () => {
    const { queries } = fakeSentry({ alice: ["11"], carol: ["11"] });
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readCards(testViewer("carol@example.com"), [
      LATENCY_URL,
    ]);

    expect(objects).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("reads each viewer's monitor once a minute", async () => {
    const { queries } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    await readCards(alice, [LATENCY_URL]);
    const { objects } = await readCards(alice, [LATENCY_URL]);

    expect(objects).toHaveLength(1);
    expect(queries).toHaveLength(2);
  });
});

describe("Sentry alert link cards", () => {
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

  it("draws an alert card from each URL form with the viewer's own read", async () => {
    const { queries } = fakeSentry({ alice: ["11"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const urls = [
      ALERT_URL,
      "https://sentry.io/organizations/sentry/monitors/alerts/301/",
    ];

    const { body, objects } = await readCards(alice, urls);

    expect(objects.map(({ object }) => object)).toEqual(
      urls.map((url) => ({
        kind: "object",
        objectType: "alert",
        plugin: "sentry",
        key: "alert:sentry:301",
        label: "New UI feedback",
        title: "New UI feedback",
        url,
        status: "Enabled",
        displayType: "Sentry alert",
        facts: {
          type: "alert",
          enabled: true,
          projects: ["checkout"],
          trigger: "First seen · Feedback · app.feedback.topic is new_ui",
          notifies: ["Email member", "Slack @burak.kaya", "Webhook"],
          lastTriggeredAt: "2026-11-17T09:30:00.000Z",
        },
      })),
    );
    // A notification target can be an email address.
    expect(body).not.toContain("ops@example.com");
    // Alice's own token reads the alert, its monitors, and their project
    // once, on the region host.
    expect(queries).toEqual([
      "Bearer alice-token us.sentry.io/api/0/organizations/sentry/workflows/301/",
      "Bearer alice-token us.sentry.io/api/0/organizations/sentry/detectors/?id=201",
      "Bearer alice-token us.sentry.io/api/0/organizations/sentry/projects/?query=id%3A11",
    ]);
  });

  it("shows nothing of an alert to a viewer who cannot see its project", async () => {
    const { queries } = fakeSentry({ alice: ["11"], bob: ["99"] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached alert must not reach Bob.
    expect((await readCards(alice, [ALERT_URL])).objects).toHaveLength(1);
    const { body, objects } = await readCards(bob, [ALERT_URL]);

    expect(objects).toEqual([]);
    expect(body).not.toContain("New UI feedback");
    expect(queries.filter((query) => query.includes("bob-token"))).toEqual([
      "Bearer bob-token us.sentry.io/api/0/organizations/sentry/workflows/301/",
    ]);
  });
});
