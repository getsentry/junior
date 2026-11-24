/**
 * Object link API helpers: a signed-in viewer's card reads, and a GitHub App
 * with webhooks for `getsentry/junior`.
 */
import { createHmac, generateKeyPairSync } from "node:crypto";
import path from "node:path";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { expect, vi } from "vitest";
import { githubPlugin } from "@sentry/junior-github";
import { createJuniorApi } from "@/api";
import { createApp, defineJuniorPlugins } from "@/app";
import type { JuniorApiEnv } from "@/api/route";
import { objectLinksReportSchema } from "@/api/schema";
import { getSqlExecutor } from "@/chat/db";
import { upsertLinkedIdentity } from "@/chat/identities/sql";
import { migratePluginSchemas } from "@/chat/plugins/migrations";
import { linkSlackUser } from "./slack-user";
import { signedInViewer } from "./user";
import { mswServer } from "../msw/server";

/**
 * Read `/api/objects` as one signed-in viewer. Returns the cards by URL.
 */
export async function viewerApi(email: string) {
  const viewer = await signedInViewer(email);
  const app = new Hono<JuniorApiEnv>();
  app.use("*", async (context, next) => {
    context.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return async (...urls: string[]) => {
    const query = new URLSearchParams(urls.map((url) => ["url", url]));
    const response = await app.request(`http://localhost/api/objects?${query}`);
    expect(response.status).toBe(200);
    // The browser may keep a card as long as the server cache does.
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("vary")).toBe("Authorization, Cookie");
    const body = await response.text();
    return {
      body,
      objects: new Map(
        objectLinksReportSchema
          .parse(JSON.parse(body))
          .objects.map((item) => [item.url, item.object]),
      ),
    };
  };
}

export const GITHUB_REPO = "https://github.com/getsentry/junior";
export const GITHUB_API = "https://api.github.com/repos/getsentry/junior";

/**
 * Configure the GitHub App. Only the GitHub account `alice_acme` can see
 * `getsentry/junior`.
 */
export function stubGitHubApp() {
  vi.stubEnv("GITHUB_APP_ID", "123");
  vi.stubEnv("GITHUB_INSTALLATION_ID", "456");
  vi.stubEnv(
    "GITHUB_APP_PRIVATE_KEY",
    generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs1" })
      .toString(),
  );
  vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
  mswServer.use(
    http.get("https://api.github.com/app/installations/456", () =>
      HttpResponse.json({
        permissions: {
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
      }),
    ),
    http.post(
      "https://api.github.com/app/installations/456/access_tokens",
      () =>
        HttpResponse.json({
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          token: "app-token",
        }),
    ),
    http.get(`${GITHUB_API}/collaborators/:login/permission`, ({ params }) =>
      HttpResponse.json({
        permission: params["login"] === "alice_acme" ? "read" : "none",
      }),
    ),
  );
}

/** Link alice@example.com to the GitHub account that sees the repository. */
export async function linkGitHubMember() {
  const alice = await linkSlackUser("alice@example.com", "UALICE");
  await upsertLinkedIdentity(getSqlExecutor(), alice.id, {
    handle: "alice_acme",
    kind: "user",
    provider: "github",
    providerSubjectId: "1001",
  });
}

/** Send a signed GitHub webhook through the app route. */
export async function sendGitHubWebhook(
  app: Awaited<ReturnType<typeof createApp>>,
  event: string,
  payload: Record<string, unknown>,
) {
  const body = JSON.stringify({
    installation: { id: 456 },
    repository: { full_name: "getsentry/junior", id: 2001 },
    sender: { login: "byk" },
    ...payload,
  });
  const response = await app.fetch(
    new Request("https://example.test/api/webhooks/github", {
      body,
      headers: {
        "x-github-delivery": `delivery-${event}-${Date.now()}`,
        "x-github-event": event,
        "x-hub-signature-256": `sha256=${createHmac("sha256", "test-secret")
          .update(body)
          .digest("hex")}`,
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(202);
}

/** Create the app with the GitHub plugin and its tables. */
export async function createGitHubApp() {
  const app = await createApp({
    plugins: defineJuniorPlugins([githubPlugin()]),
  });
  // Webhooks record lifecycles in the plugin's tables.
  await migratePluginSchemas(getSqlExecutor(), [
    {
      dir: path.resolve(process.cwd(), "../junior-github/migrations"),
      pluginName: "github",
    },
  ]);
  return app;
}
