import {
  defineJuniorPlugin,
  type IssueCredentialHookContext,
  type User,
} from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, expect, it, vi } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { createUserTokenStore } from "@/chat/capabilities/factory";
import { closeDb } from "@/chat/db";
import { defineJuniorPlugins } from "@/plugins";
import { testViewer } from "../../fixtures/user";
import { mswServer } from "../../msw/server";

const manifest = {
  name: "docs",
  displayName: "Docs",
  description: "Docs test plugin",
  configKeys: [],
  domains: ["api.docs.test"],
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
});

it("reads link cards through plugin-owned credentials as a system Actor", async () => {
  const issued: IssueCredentialHookContext[] = [];
  await createApp({
    dashboard: { disabled: true },
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest,
        hooks: {
          grantForEgress: () => ({ name: "app", access: "read" }),
          issueCredential(ctx) {
            issued.push(ctx);
            return {
              type: "lease",
              lease: {
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                headerTransforms: [
                  {
                    domain: "api.docs.test",
                    headers: { Authorization: "Bearer app-token" },
                  },
                ],
              },
            };
          },
        },
        objectLinks: [
          {
            filters: [{ host: "docs.test", pathPrefix: "/d/" }],
            objectTypes: ["document"],
            canView: async () => true,
            async resolve(ctx, url) {
              const response = await ctx.egress.fetch({
                operation: "docs.file.get",
                provider: "docs",
                request: new Request(`https://api.docs.test${url.pathname}`),
              });
              const file = (await response.json()) as { title: string };
              return {
                kind: "object",
                objectType: "document",
                key: url.pathname,
                label: file.title,
                title: file.title,
                url: url.href,
              };
            },
          },
        ],
      }),
    ]),
  });
  mswServer.use(
    http.get("https://api.docs.test/d/1", ({ request }) =>
      request.headers.get("authorization") === "Bearer app-token"
        ? HttpResponse.json({ title: "Launch plan" })
        : new HttpResponse(null, { status: 401 }),
    ),
  );
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", testViewer("alice@example.com"));
    await next();
  });
  app.route("/", createJuniorApi());

  const response = await app.request(
    `http://localhost/api/objects?url=${encodeURIComponent("https://docs.test/d/1")}`,
  );

  expect(response.status).toBe(200);
  expect(
    objectLinksReportSchema.parse(await response.json()).objects,
  ).toMatchObject([
    {
      url: "https://docs.test/d/1",
      object: { objectType: "document", plugin: "docs", title: "Launch plan" },
    },
  ]);
  // The viewer is never the credential subject.
  expect(issued.map((ctx) => [ctx.actor, ctx.credentialSubject])).toEqual([
    [{ platform: "system", name: "object-link" }, undefined],
  ]);
});

const oauthManifest = {
  name: "tracker",
  displayName: "Tracker",
  description: "Tracker test plugin",
  configKeys: [],
  credentials: {
    authTokenEnv: "TRACKER_TOKEN",
    domains: ["api.tracker.test"],
    type: "oauth-bearer" as const,
  },
  oauth: {
    authorizeEndpoint: "https://tracker.test/oauth/authorize",
    clientIdEnv: "TRACKER_CLIENT_ID",
    clientSecretEnv: "TRACKER_CLIENT_SECRET",
    scope: "read",
    tokenEndpoint: "https://tracker.test/oauth/token",
  },
};

it("checks link access with only the viewer's own OAuth token", async () => {
  // An app token and an environment token exist. Neither may reach the
  // viewer check.
  vi.stubEnv("TRACKER_TOKEN", "env-token");
  const checks: Array<string | null> = [];
  const statuses: number[] = [];
  await createApp({
    dashboard: { disabled: true },
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: oauthManifest,
        hooks: {
          grantForEgress: () => ({ name: "app", access: "read" }),
          issueCredential: () => ({
            type: "lease",
            lease: {
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              headerTransforms: [
                {
                  domain: "api.tracker.test",
                  headers: { Authorization: "Bearer app-token" },
                },
              ],
            },
          }),
        },
        objectLinks: [
          {
            filters: [{ host: "tracker.test", pathPrefix: "/t/" }],
            async canView(ctx, url) {
              const response = await ctx.viewerEgress.fetch({
                operation: "tracker.ticket.access",
                provider: "tracker",
                request: new Request(`https://api.tracker.test${url.pathname}`),
              });
              statuses.push(response.status);
              return response.ok;
            },
            objectTypes: ["task"],
            async resolve(_ctx, url) {
              return {
                kind: "object",
                objectType: "task",
                key: url.pathname,
                label: "T-1",
                title: "Fix the login page",
                url: url.href,
              };
            },
          },
        ],
      }),
    ]),
  });
  mswServer.use(
    http.get("https://api.tracker.test/t/1", ({ request }) => {
      const authorization = request.headers.get("authorization");
      checks.push(authorization);
      return authorization === "Bearer alice-token"
        ? HttpResponse.json({})
        : new HttpResponse(null, { status: 403 });
    }),
  );
  const tokens = createUserTokenStore();
  const alice = testViewer("alice@example.com");
  const bob = testViewer("bob@example.com");
  await tokens.set(alice.id, "tracker", {
    accessToken: "alice-token",
    refreshToken: "alice-refresh",
    expiresAt: Date.now() + 3_600_000,
    scope: "read",
  });
  const url = "https://tracker.test/t/1";
  const read = async (viewer: User) => {
    const app = new Hono<JuniorApiEnv>();
    app.use("*", async (context, next) => {
      context.set("viewer", viewer);
      await next();
    });
    app.route("/", createJuniorApi());
    const response = await app.request(
      `http://localhost/api/objects?url=${encodeURIComponent(url)}`,
    );
    expect(response.status).toBe(200);
    return objectLinksReportSchema.parse(await response.json()).objects;
  };

  expect(await read(alice)).toMatchObject([
    { url, object: { plugin: "tracker", title: "Fix the login page" } },
  ]);
  // Bob has no token. He gets 401 and no card: the request never leaves
  // with Alice's token, the app token, or the environment token, and the
  // link read does not ask him to connect.
  expect(await read(bob)).toEqual([]);
  expect(checks).toEqual(["Bearer alice-token"]);
  expect(statuses).toEqual([200, 401]);
});

/** Read `/api/objects` for one URL as one viewer. */
async function readCards(viewer: User, url: string) {
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  const response = await app.request(
    `http://localhost/api/objects?url=${encodeURIComponent(url)}`,
  );
  expect(response.status).toBe(200);
  return objectLinksReportSchema.parse(await response.json()).objects;
}

/** The docs plugin, whose card reads the file title as the system Actor. */
async function createDocsApp() {
  await createApp({
    dashboard: { disabled: true },
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest,
        hooks: {
          grantForEgress: () => ({ name: "app", access: "read" }),
          issueCredential: () => ({
            type: "lease",
            lease: {
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              headerTransforms: [
                {
                  domain: "api.docs.test",
                  headers: { Authorization: "Bearer app-token" },
                },
              ],
            },
          }),
        },
        objectLinks: [
          {
            filters: [{ host: "docs.test", pathPrefix: "/d/" }],
            objectTypes: ["document"],
            canView: async () => true,
            async resolve(ctx, url) {
              // Like Sentry and Google, the plugin keeps its own copy of
              // what it read.
              const file = await ctx.cache.getOrLoad(
                `file:${url.pathname}`,
                async () => {
                  const response = await ctx.egress.fetch({
                    operation: "docs.file.get",
                    provider: "docs",
                    request: new Request(
                      `https://api.docs.test${url.pathname}`,
                    ),
                  });
                  if (!response.ok) throw new Error(`HTTP ${response.status}`);
                  return {
                    ttlMs: 20_000,
                    value: (await response.json()) as { title: string },
                  };
                },
              );
              return {
                kind: "object",
                objectType: "document",
                key: url.pathname,
                label: file.title,
                title: file.title,
                url: url.href,
              };
            },
          },
        ],
      }),
    ]),
  });
}

it("serves a card read from the HTTP cache within its TTL, then revalidates it, and a 304 keeps the entry", async () => {
  await createDocsApp();
  const sent: Array<string | null> = [];
  let answer: "file" | "not_modified" = "file";
  mswServer.use(
    http.get("https://api.docs.test/d/2", ({ request }) => {
      sent.push(request.headers.get("if-none-match"));
      return answer === "file"
        ? HttpResponse.json(
            { title: "Launch plan" },
            { headers: { etag: '"v1"' } },
          )
        : new HttpResponse(null, { status: 304 });
    }),
  );
  const alice = testViewer("alice@example.com");
  const url = "https://docs.test/d/2";
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = Date.now();
    expect(await readCards(alice, url)).toMatchObject([
      { object: { title: "Launch plan" } },
    ]);
    // Within the TTL, the entry serves with no request.
    vi.setSystemTime(start + 30_000);
    expect(await readCards(alice, url)).toMatchObject([
      { object: { title: "Launch plan" } },
    ]);
    expect(sent).toEqual([null]);

    // After the TTL, Junior asks with the entry's ETag. The 304 keeps the
    // entry, so the next minute needs no request either.
    answer = "not_modified";
    vi.setSystemTime(start + 61_000);
    const revalidated = await readCards(alice, url);
    expect(revalidated).toMatchObject([{ object: { title: "Launch plan" } }]);
    expect(revalidated[0]?.object).not.toHaveProperty("fetchedAt");
    vi.setSystemTime(start + 100_000);
    await readCards(alice, url);
    expect(sent).toEqual([null, '"v1"']);
  } finally {
    vi.useRealTimers();
  }
});

it("shows the last card with when it was fetched only after its TTL, when the provider fails", async () => {
  await createDocsApp();
  let up = true;
  mswServer.use(
    http.get("https://api.docs.test/d/3", () =>
      up
        ? HttpResponse.json({ title: "Roadmap" })
        : HttpResponse.json({ message: "Unavailable" }, { status: 503 }),
    ),
  );
  const alice = testViewer("alice@example.com");
  const url = "https://docs.test/d/3";
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const start = Date.now();
    const fresh = await readCards(alice, url);
    expect(fresh).toMatchObject([{ object: { title: "Roadmap" } }]);
    expect(fresh[0]?.object).not.toHaveProperty("fetchedAt");

    // Within the TTL, the card is fresh, even with the provider down.
    up = false;
    vi.setSystemTime(start + 30_000);
    const cached = await readCards(alice, url);
    expect(cached[0]?.object).not.toHaveProperty("fetchedAt");

    // After the TTL, the failed read shows the last card and its age.
    vi.setSystemTime(start + 5 * 60_000);
    expect(await readCards(alice, url)).toMatchObject([
      {
        object: {
          fetchedAt: new Date(start).toISOString(),
          title: "Roadmap",
        },
      },
    ]);
    // The plugin did not save the old body as a fresh copy, so the next
    // read still shows its age.
    vi.setSystemTime(start + 5 * 60_000 + 10_000);
    expect(await readCards(alice, url)).toMatchObject([
      { object: { fetchedAt: new Date(start).toISOString() } },
    ]);

    // A good read again shows a current card.
    up = true;
    const current = await readCards(alice, url);
    expect(current[0]?.object).not.toHaveProperty("fetchedAt");
  } finally {
    vi.useRealTimers();
  }
});

it("shares a cached response only within one credential: viewers share the app's, never each other's", async () => {
  const access: Array<string | null> = [];
  const appReads: Array<string | null> = [];
  await createApp({
    dashboard: { disabled: true },
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: oauthManifest,
        hooks: {
          grantForEgress: () => ({ name: "app", access: "read" }),
          issueCredential: () => ({
            type: "lease",
            lease: {
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              headerTransforms: [
                {
                  domain: "api.tracker.test",
                  headers: { Authorization: "Bearer app-token" },
                },
              ],
            },
          }),
        },
        objectLinks: [
          {
            filters: [{ host: "tracker.test", pathPrefix: "/t/" }],
            async canView(ctx, url) {
              const response = await ctx.viewerEgress.fetch({
                operation: "tracker.ticket.access",
                provider: "tracker",
                request: new Request(
                  `https://api.tracker.test${url.pathname}/access`,
                ),
              });
              return response.ok;
            },
            objectTypes: ["task"],
            async resolve(ctx, url) {
              const response = await ctx.egress.fetch({
                operation: "tracker.ticket.get",
                provider: "tracker",
                request: new Request(`https://api.tracker.test${url.pathname}`),
              });
              const ticket = (await response.json()) as { title: string };
              return {
                kind: "object",
                objectType: "task",
                key: url.pathname,
                label: "T-2",
                title: ticket.title,
                url: url.href,
              };
            },
          },
        ],
      }),
    ]),
  });
  mswServer.use(
    http.get("https://api.tracker.test/t/2/access", ({ request }) => {
      const authorization = request.headers.get("authorization");
      access.push(authorization);
      return HttpResponse.json(
        { reader: authorization },
        { headers: { etag: '"access"' } },
      );
    }),
    http.get("https://api.tracker.test/t/2", ({ request }) => {
      appReads.push(request.headers.get("authorization"));
      return HttpResponse.json(
        { title: "Fix the login page" },
        { headers: { etag: '"t2"' } },
      );
    }),
  );
  const tokens = createUserTokenStore();
  const alice = testViewer("alice@example.com");
  const bob = testViewer("bob@example.com");
  for (const [viewer, token] of [
    [alice, "alice-token"],
    [bob, "bob-token"],
  ] as const) {
    await tokens.set(viewer.id, "tracker", {
      accessToken: token,
      refreshToken: `${token}-refresh`,
      expiresAt: Date.now() + 3_600_000,
      scope: "read",
    });
  }
  const url = "https://tracker.test/t/2";

  for (const viewer of [alice, bob, alice]) {
    expect(await readCards(viewer, url)).toMatchObject([
      { object: { title: "Fix the login page" } },
    ]);
  }
  // Alice's access answer is fresh, but Bob's check sends his own token.
  expect(access).toEqual(["Bearer alice-token", "Bearer bob-token"]);
  // The viewers share the one read with the app's credential.
  expect(appReads).toEqual(["Bearer app-token"]);
});
