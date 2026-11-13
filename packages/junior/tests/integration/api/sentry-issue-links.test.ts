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

const ISSUE = {
  assignedTo: { email: "ada@example.com", name: "Ada Lovelace", type: "user" },
  count: "1234",
  culprit: "app/checkout.ts in submitOrder",
  id: "4567",
  lastSeen: "2026-07-01T10:00:00.000Z",
  level: "error",
  metadata: { type: "TypeError", value: "cart.total is undefined" },
  priority: "high",
  project: { id: "11", slug: "junior" },
  shortId: "JUNIOR-3ZK",
  status: "unresolved",
  substatus: "regressed",
  title: "TypeError: cart.total is undefined",
  userCount: 56,
};

// Each org's region API host, as `links.regionUrl` names it.
const REGION_URLS: Record<string, string> = {
  "acme-eu": "https://de.sentry.io",
  rogue: "https://sentry.example.com",
  sentry: "https://us.sentry.io",
};

/**
 * Fake Sentry's org and issue APIs. `sentry.io` names each org's region.
 * The region host answers for its own orgs only. Each viewer token opens
 * the issue only when it is listed in `allowed`. The org read token reads
 * every issue.
 */
function fakeSentry(allowed: string[]) {
  const reads: string[] = [];
  const issueHosts: string[] = [];
  const orgReads: string[] = [];
  const issueRead: Parameters<typeof http.get>[1] = ({ params, request }) => {
    const host = new URL(request.url).host;
    const token = request.headers.get("authorization") ?? "none";
    issueHosts.push(`${host} ${params.org}`);
    reads.push(`${token} ${params.org}/${params.issueId}`);
    const known =
      REGION_URLS[String(params.org)] === `https://${host}` &&
      [ISSUE.id, ISSUE.shortId].includes(String(params.issueId));
    if (!known) return new HttpResponse(null, { status: 404 });
    const canRead =
      token === `Bearer ${ORG_READ_TOKEN}` ||
      allowed.some((name) => token === `Bearer ${name}-token`);
    return canRead
      ? HttpResponse.json(ISSUE)
      : new HttpResponse(null, { status: 403 });
  };
  mswServer.use(
    http.get("https://sentry.io/api/0/organizations/:org/", ({ params }) => {
      const org = String(params.org);
      orgReads.push(org);
      const regionUrl = REGION_URLS[org];
      return regionUrl
        ? HttpResponse.json({ slug: org, links: { regionUrl } })
        : new HttpResponse(null, { status: 404 });
    }),
    ...Object.values(REGION_URLS).map((origin) =>
      http.get(
        `${origin}/api/0/organizations/:org/issues/:issueId/`,
        issueRead,
      ),
    ),
  );
  return { issueHosts, orgReads, reads };
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

describe("Sentry issue link cards", () => {
  beforeEach(async () => {
    vi.stubEnv("SENTRY_READ_TOKEN", ORG_READ_TOKEN);
    await createApp({
      dashboard: { disabled: true },
      plugins: defineJuniorPlugins([sentryPlugin()]),
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await closeDb();
  });

  it("shows an issue card to a viewer whose Sentry account can open it", async () => {
    const { reads } = fakeSentry(["alice"]);
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = "https://sentry.sentry.io/issues/4567/";

    const { objects } = await readCards(alice, [url]);

    expect(objects).toEqual([
      {
        url,
        object: {
          kind: "object",
          objectType: "task",
          plugin: "sentry",
          key: "sentry/4567",
          label: "JUNIOR-3ZK",
          title: "TypeError: cart.total is undefined",
          url,
          displayType: "Sentry issue",
          status: "unresolved",
          description: "1,234 events, 56 users",
          sourceUpdatedAt: "2026-07-01T10:00:00.000Z",
          facts: {
            type: "task",
            summary: "app/checkout.ts in submitOrder",
            assignees: ["Ada Lovelace"],
            priority: "High",
            project: "junior",
            labels: ["error", "regressed"],
          },
        },
      },
    ]);
    // Alice's own token checks access. Junior's org read token reads the
    // card.
    expect(reads).toEqual([
      "Bearer alice-token sentry/4567",
      `Bearer ${ORG_READ_TOKEN} sentry/4567`,
    ]);
  });

  it("resolves every issue URL form to the same issue", async () => {
    const { reads } = fakeSentry(["alice"]);
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const urls = [
      "https://sentry.io/organizations/sentry/issues/4567/",
      "https://sentry.io/organizations/sentry/issues/4567/events/latest/?project=11",
      "https://sentry.sentry.io/issues/4567/events/recommended/",
      "https://sentry.sentry.io/issues/4567/events/0123456789abcdef0123456789abcdef/",
      "https://sentry.sentry.io/issues/JUNIOR-3ZK/",
    ];
    // Sentry pages that are not one issue claim no card and send nothing.
    const others = [
      "https://sentry.sentry.io/issues/errors-outages/",
      "https://sentry.sentry.io/issues/4567/tags/",
      "https://sentry.sentry.io/issues/4567/events/not-an-event/",
      "https://docs.sentry.sentry.io/issues/4567/",
    ];

    const { objects } = await readCards(alice, [...urls, ...others]);

    expect(objects.map((card) => card.url)).toEqual(urls);
    expect(new Set(objects.map((card) => card.object.key))).toEqual(
      new Set(["sentry/4567"]),
    );
    expect(reads.every((read) => /sentry\/(4567|JUNIOR-3ZK)$/.test(read))).toBe(
      true,
    );
  });

  it("shows nothing of an issue to a viewer whose Sentry account cannot open it", async () => {
    const { reads } = fakeSentry([]);
    const bob = testViewer("bob@example.com");
    await connectSentry(bob, "bob");

    const { body, objects } = await readCards(bob, [
      "https://sentry.sentry.io/issues/4567/",
    ]);

    expect(objects).toEqual([]);
    for (const text of [ISSUE.title, ISSUE.shortId, "Ada", "junior"]) {
      expect(body).not.toContain(text);
    }
    // Only Bob's own token asks. Egress retries a 403 once. The card is
    // never read for him.
    expect(new Set(reads)).toEqual(new Set(["Bearer bob-token sentry/4567"]));
  });

  it("shows no card to a viewer who has not connected Sentry", async () => {
    const { reads } = fakeSentry(["alice"]);
    // Alice is connected. Her token must not stand in for Carol.
    await connectSentry(testViewer("alice@example.com"), "alice");

    const { objects } = await readCards(testViewer("carol@example.com"), [
      "https://sentry.sentry.io/issues/4567/",
    ]);

    expect(objects).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("sends each org's issue calls to its region host", async () => {
    const { issueHosts } = fakeSentry(["alice"]);
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [
      "https://sentry.sentry.io/issues/4567/",
      "https://acme-eu.sentry.io/issues/4567/",
    ]);

    expect(objects.map((card) => card.object.key)).toEqual([
      "sentry/4567",
      "acme-eu/4567",
    ]);
    // The viewer check and the card read both go to the region host.
    expect([...issueHosts].sort()).toEqual([
      "de.sentry.io acme-eu",
      "de.sentry.io acme-eu",
      "us.sentry.io sentry",
      "us.sentry.io sentry",
    ]);
  });

  it("refuses a region host that is not a Sentry API host", async () => {
    const { issueHosts, orgReads, reads } = fakeSentry(["alice"]);
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");

    const { objects } = await readCards(alice, [
      "https://rogue.sentry.io/issues/4567/",
    ]);

    // Junior reads the org's region, then calls nothing there.
    expect(orgReads).toEqual(["rogue"]);
    expect(objects).toEqual([]);
    expect(issueHosts).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("retries a refused region lookup after a minute", async () => {
    const { orgReads } = fakeSentry(["alice"]);
    // The org read token is refused until Sentry grants it.
    let refused = true;
    mswServer.use(
      http.get("https://sentry.io/api/0/organizations/:org/", () =>
        refused ? new HttpResponse(null, { status: 403 }) : undefined,
      ),
    );
    const alice = testViewer("alice@example.com");
    await connectSentry(alice, "alice");
    const url = "https://sentry.sentry.io/issues/4567/";

    expect((await readCards(alice, [url])).objects).toEqual([]);
    refused = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 61_000);

    expect((await readCards(alice, [url])).objects).toHaveLength(1);
    expect(orgReads).toEqual(["sentry"]);
  });

  it("reads each issue once for every viewer and checks each viewer", async () => {
    const { orgReads, reads } = fakeSentry(["alice", "dave"]);
    const alice = testViewer("alice@example.com");
    const dave = testViewer("dave@example.com");
    await connectSentry(alice, "alice");
    await connectSentry(dave, "dave");
    const url = "https://sentry.sentry.io/issues/4567/";

    await readCards(alice, [url]);
    await readCards(alice, [url]);
    const { objects } = await readCards(dave, [url]);

    expect(objects).toHaveLength(1);
    expect(reads).toEqual([
      "Bearer alice-token sentry/4567",
      `Bearer ${ORG_READ_TOKEN} sentry/4567`,
      "Bearer dave-token sentry/4567",
    ]);
    // The org's region is looked up once.
    expect(orgReads).toEqual(["sentry"]);
  });
});
