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

const TRACE_ID = "a8c0e1b2d3f4a5b6c7d8e9f0a1b2c3d4";
const START = 1782896400;
const TRACE_URL = `https://sentry.sentry.io/explore/traces/trace/${TRACE_ID}/?timestamp=${START}`;

function span(
  project: string,
  op: string,
  name: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
) {
  return {
    event_type: "span",
    project_slug: project,
    op,
    description: name,
    start_timestamp: START + from,
    end_timestamp: START + to,
    // Every span of a transaction carries the transaction's name.
    transaction: "GET /api/checkout",
    errors: [],
    occurrences: [],
    children: [],
    ...extra,
  };
}

const CHECKOUT_TRACE = [
  span("frontend", "http.server", "GET /api/checkout", 0, 2.4, {
    children: [
      span("frontend", "db", "SELECT * FROM carts", 0.1, 0.4),
      span("payments", "http.client", "POST /charge", 0.5, 2, {
        errors: [{ title: "TypeError: cart.total is undefined" }],
        children: [span("billing", "db", "UPDATE invoices", 0.6, 0.9)],
      }),
    ],
  }),
];

/**
 * Fake Sentry's org, trace-meta, and trace APIs. Like Sentry, a token sees
 * only the trace items of projects that `projects` lists for its viewer,
 * and Junior's org read token sees no trace data. The trace is older than
 * the default 14 days, so Sentry finds it only near its timestamp.
 */
function fakeSentry(
  projects: Record<string, string[]>,
  trace: Array<Record<string, unknown>> = CHECKOUT_TRACE,
) {
  const queries: string[] = [];
  const visible = (request: Request) => {
    const url = new URL(request.url);
    queries.push(
      `${request.headers.get("authorization")} ${url.host}${url.pathname}?${url.searchParams}`,
    );
    if (!url.searchParams.has("timestamp")) return [];
    const token = request.headers.get("authorization") ?? "none";
    const viewer = token.replace(/^Bearer (.+)-token$/, "$1");
    return trace.filter((node) =>
      projects[viewer]?.includes(String(node.project_slug)),
    );
  };
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) =>
      HttpResponse.json({ slug: params.org, links: { regionUrl: REGION } }),
    ),
    http.get(
      `${REGION}/api/0/organizations/sentry/trace-meta/:traceId/`,
      ({ request }) => {
        const seen = visible(request).length > 0;
        return HttpResponse.json({
          errorsCount: seen ? 1 : 0,
          performanceIssuesCount: seen ? 2 : 0,
          projectCount: seen ? 3 : 0,
          spansCount: seen ? 4 : 0,
          spansCountMap: {},
          transactionChildCountMap: [],
          uptimeCount: 0,
          logsCount: 0,
        });
      },
    ),
    http.get(
      `${REGION}/api/0/organizations/sentry/trace/:traceId/`,
      ({ request }) => HttpResponse.json(visible(request)),
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

describe("Sentry trace link cards", () => {
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

  it("draws a trace card from the viewer's own read", async () => {
    const { queries } = fakeSentry({ alice: ["frontend"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [TRACE_URL]);

    expect(objects).toEqual([
      {
        url: TRACE_URL,
        object: {
          kind: "object",
          objectType: "trace",
          plugin: "sentry",
          key: `trace:sentry/${TRACE_ID}`,
          label: "a8c0e1b2",
          title: "GET /api/checkout",
          url: TRACE_URL,
          displayType: "Sentry trace",
          facts: {
            type: "trace",
            rootOp: "http.server",
            rootName: "GET /api/checkout",
            durationMs: 2400,
            spanCount: 4,
            errorCount: 1,
            performanceIssueCount: 2,
            projects: ["frontend", "payments", "billing"],
            spans: [
              {
                op: "http.server",
                name: "GET /api/checkout",
                startMs: 0,
                durationMs: 2400,
              },
              {
                op: "db",
                name: "SELECT * FROM carts",
                startMs: 100,
                durationMs: 300,
              },
              {
                op: "http.client",
                name: "POST /charge",
                startMs: 500,
                durationMs: 1500,
                issue: true,
              },
            ],
          },
        },
      },
    ]);
    // Alice's own token reads the trace on the region host, near the
    // link's timestamp. Junior's org read token reads no trace data.
    const path = `us.sentry.io/api/0/organizations/sentry`;
    expect(queries.sort()).toEqual([
      `Bearer alice-token ${path}/trace-meta/${TRACE_ID}/?timestamp=${START}`,
      `Bearer alice-token ${path}/trace/${TRACE_ID}/?timestamp=${START}`,
    ]);
  });

  it("shows nothing of a trace to a viewer who cannot see its projects", async () => {
    const { queries } = fakeSentry({ alice: ["frontend"], bob: ["mobile"] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached trace must not reach Bob.
    expect((await readCards(alice, [TRACE_URL])).objects).toHaveLength(1);
    const { body, objects } = await readCards(bob, [TRACE_URL]);

    expect(objects).toEqual([]);
    for (const text of ["GET /api/checkout", "POST /charge", "payments"]) {
      expect(body).not.toContain(text);
    }
    expect(queries.filter((query) => query.includes("bob-token"))).toHaveLength(
      2,
    );
  });

  it("shows no trace to a viewer who has not connected Sentry", async () => {
    const { queries } = fakeSentry({
      alice: ["frontend"],
      carol: ["frontend"],
    });
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readCards(testViewer("carol@example.com"), [
      TRACE_URL,
    ]);

    expect(objects).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("reads each viewer's trace once a minute", async () => {
    const { queries } = fakeSentry({ alice: ["frontend"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    await readCards(alice, [TRACE_URL]);
    const { objects } = await readCards(alice, [TRACE_URL]);

    expect(objects).toHaveLength(1);
    expect(queries).toHaveLength(2);
  });

  it("reads a trace again for a link with another time window", async () => {
    fakeSentry({ alice: ["frontend"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const untimed = new URL(TRACE_URL);
    untimed.search = "";

    // Without its timestamp, Sentry does not find this old trace. That
    // miss must not hide the trace from a link that has the timestamp.
    expect((await readCards(alice, [untimed.href])).objects).toEqual([]);
    const { objects } = await readCards(alice, [TRACE_URL]);

    expect(objects.map(({ object }) => object.title)).toEqual([
      "GET /api/checkout",
    ]);
  });

  it("fits many long spans in the card facts limit", async () => {
    const long = (index: number) => `${index} ${"x".repeat(200)}`;
    fakeSentry({ alice: ["frontend"] }, [
      span("frontend", "op".repeat(100), long(0), 0, 30, {
        children: Array.from({ length: 30 }, (_, index) =>
          span("frontend", "op".repeat(100), long(index + 1), index, index + 1),
        ),
      }),
    ]);
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [TRACE_URL]);

    const facts = objects[0]?.object.facts;
    if (facts?.type !== "trace") throw new Error("Expected a trace card");
    expect(facts.spans.length).toBeGreaterThan(0);
    expect(facts.spans.length).toBeLessThanOrEqual(12);
    expect(facts.spans[0]!.name).toMatch(/^0 x+$/);
    expect(JSON.stringify(facts).length).toBeLessThanOrEqual(4096);
  });
});
