import {
  defineJuniorPlugin,
  type IssueCredentialHookContext,
} from "@sentry/junior-plugin-api";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { afterEach, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { createApp } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
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
