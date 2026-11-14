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

const EVENT_ID = "7d3e9b1a5c2f4e8d9a0b6c1d2e3f4a5b";
const EVENT_URL = `https://sentry.sentry.io/projects/checkout/events/${EVENT_ID}/`;

const CHECKOUT_EVENT = {
  id: EVENT_ID,
  eventID: EVENT_ID,
  groupID: "4567",
  projectID: "11",
  title: "TypeError: cart.total is undefined",
  culprit: "app/checkout.ts in submitOrder",
  message: null,
  dateCreated: "2026-11-13T21:40:50.000Z",
  tags: [
    { key: "level", value: "error" },
    { key: "environment", value: "production" },
    { key: "release", value: "checkout@4.2.0" },
    { key: "user.email", value: "shopper@example.com" },
  ],
  release: { version: "checkout@4.2.0" },
  user: { email: "shopper@example.com" },
  entries: [],
};

/**
 * Fake Sentry's org and project event APIs. Like Sentry, a token reads an
 * event only in a project that `projects` lists for its viewer, and
 * Junior's org read token reads no event.
 */
function fakeSentry(projects: Record<string, string[]>) {
  const queries: string[] = [];
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) =>
      HttpResponse.json({ slug: params.org, links: { regionUrl: REGION } }),
    ),
    http.get(
      `${REGION}/api/0/projects/sentry/:project/events/:eventId/`,
      ({ params, request }) => {
        const token = request.headers.get("authorization") ?? "none";
        const url = new URL(request.url);
        queries.push(`${token} ${url.host}${url.pathname}`);
        const viewer = token.replace(/^Bearer (.+)-token$/, "$1");
        return projects[viewer]?.includes(String(params.project)) &&
          params.eventId === EVENT_ID
          ? HttpResponse.json(CHECKOUT_EVENT)
          : HttpResponse.json({ detail: "Not found" }, { status: 404 });
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

describe("Sentry event link cards", () => {
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

  it("draws an event card from the viewer's own read", async () => {
    const { queries } = fakeSentry({ alice: ["checkout"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { body, objects } = await readCards(alice, [EVENT_URL]);

    expect(objects).toEqual([
      {
        url: EVENT_URL,
        object: {
          kind: "object",
          objectType: "event",
          plugin: "sentry",
          key: `event:sentry/checkout:${EVENT_ID}`,
          label: "7d3e9b1a",
          title: "TypeError: cart.total is undefined",
          url: EVENT_URL,
          displayType: "Sentry event",
          facts: {
            type: "event",
            summary: "app/checkout.ts in submitOrder",
            level: "error",
            project: "checkout",
            release: "checkout@4.2.0",
            environment: "production",
            occurredAt: "2026-11-13T21:40:50.000Z",
          },
        },
      },
    ]);
    // The card copies no other tags and no user data.
    expect(body).not.toContain("shopper@example.com");
    // Alice's own token reads the event on the region host. Junior's org
    // read token reads no event.
    expect(queries).toEqual([
      `Bearer alice-token us.sentry.io/api/0/projects/sentry/checkout/events/${EVENT_ID}/`,
    ]);
  });

  it("reads the legacy and sentry.io URL forms", async () => {
    fakeSentry({ alice: ["checkout"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const urls = [
      `https://sentry.io/organizations/sentry/projects/checkout/events/${EVENT_ID}/`,
      `https://sentry.io/sentry/checkout/events/${EVENT_ID}/`,
    ];

    const { objects } = await readCards(alice, urls);

    expect(objects.map(({ object }) => object.key)).toEqual([
      `event:sentry/checkout:${EVENT_ID}`,
      `event:sentry/checkout:${EVENT_ID}`,
    ]);
  });

  it("shows nothing of an event to a viewer who cannot see its project", async () => {
    const { queries } = fakeSentry({ alice: ["checkout"], bob: ["mobile"] });
    const alice = testViewer("alice@example.com");
    const bob = testViewer("bob@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(bob, "bob");

    // Alice's cached event must not reach Bob.
    expect((await readCards(alice, [EVENT_URL])).objects).toHaveLength(1);
    const { body, objects } = await readCards(bob, [EVENT_URL]);

    expect(objects).toEqual([]);
    for (const text of ["cart.total", "checkout@4.2.0", "submitOrder"]) {
      expect(body).not.toContain(text);
    }
    expect(queries.filter((query) => query.includes("bob-token"))).toHaveLength(
      1,
    );
  });

  it("shows no event to a viewer who has not connected Sentry", async () => {
    const { queries } = fakeSentry({
      alice: ["checkout"],
      carol: ["checkout"],
    });
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readCards(testViewer("carol@example.com"), [
      EVENT_URL,
    ]);

    expect(objects).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("reads each viewer's event once a minute", async () => {
    const { queries } = fakeSentry({ alice: ["checkout"] });
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    await readCards(alice, [EVENT_URL]);
    const { objects } = await readCards(alice, [EVENT_URL]);

    expect(objects).toHaveLength(1);
    expect(queries).toHaveLength(1);
  });
});
