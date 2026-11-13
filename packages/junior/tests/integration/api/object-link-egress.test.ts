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
            objectType: "document",
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
            objectType: "task",
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
