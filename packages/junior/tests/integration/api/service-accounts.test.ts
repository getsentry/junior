import { Hono } from "hono";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { serviceAccountListSchema } from "@/api/schema";
import { closeDb, getDb } from "@/chat/db";
import { createPluginEgress } from "@/chat/egress/plugin";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import {
  SERVICE_ACCOUNT_MCP_CODE,
  SERVICE_ACCOUNT_MCP_URL,
  useServiceAccountMcpServer,
} from "../../fixtures/service-account-mcp";
import { mswServer } from "../../msw/server";

const ORIGINAL_ENV = { ...process.env };
const BASE_URL = "https://junior.example.com";
const ADMIN = "admin@example.com";
const OTHER_ADMIN = "other-admin@example.com";
const PERSON = "person@example.com";

async function createServiceAccountApp(): Promise<void> {
  const { createApp, defineJuniorPlugins } = await import("@/app");
  await createApp({
    plugins: defineJuniorPlugins([
      defineJuniorPlugin({
        manifest: {
          name: "docs-mcp",
          displayName: "Docs",
          description: "Docs MCP server",
          mcp: {
            transport: "http",
            url: SERVICE_ACCOUNT_MCP_URL,
            allowedTools: ["search", "create"],
          },
          accounts: { serviceAccount: { tools: ["search"] } },
        },
      }),
      // A REST plugin that only the shared account may use, like Vimeo.
      defineJuniorPlugin({
        manifest: {
          name: "clips",
          displayName: "Clips",
          description: "Clips video API",
          credentials: {
            type: "oauth-bearer",
            domains: ["api.clips.test"],
          },
          oauth: {
            clientIdEnv: "CLIPS_CLIENT_ID",
            clientSecretEnv: "CLIPS_CLIENT_SECRET",
            authorizeEndpoint: "https://clips.test/oauth/authorize",
            tokenEndpoint: "https://clips.test/oauth/access_token",
            scope: "public upload",
            tokenAuthMethod: "basic",
          },
          accounts: {
            userOAuth: false,
            serviceAccount: { operations: ["clips.upload"] },
          },
        },
      }),
    ]),
  });
}

function authenticatedApi(email: string) {
  const app = new Hono<{ Variables: JuniorApiVariables }>();
  app.use("*", async (c, next) => {
    const viewer = await resolveViewerUser(email);
    if (!viewer) throw new Error(`missing viewer for ${email}`);
    c.set("viewer", viewer);
    await next();
  });
  app.route("/", createJuniorApi());
  return app;
}

async function listServiceAccounts(app: ReturnType<typeof authenticatedApi>) {
  const response = await app.request(`${BASE_URL}/api/service-accounts`);
  expect(response.status).toBe(200);
  return serviceAccountListSchema.parse(await response.json()).serviceAccounts;
}

async function startSignIn(
  app: ReturnType<typeof authenticatedApi>,
  provider = "docs-mcp",
) {
  const response = await app.request(
    `${BASE_URL}/api/service-accounts/${provider}`,
    {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    },
  );
  expect(response.status).toBe(200);
  const { authorizationUrl } = (await response.json()) as {
    authorizationUrl: string;
  };
  return new URL(authorizationUrl);
}

/** Return from the provider with an approved sign-in, like a browser. */
async function finishSignIn(
  app: ReturnType<typeof authenticatedApi>,
  authorization: URL,
  code = SERVICE_ACCOUNT_MCP_CODE,
) {
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  return await app.request(callback.toString());
}

describe("service accounts API", () => {
  beforeEach(async () => {
    process.env = { ...ORIGINAL_ENV, JUNIOR_BASE_URL: BASE_URL };
    await createServiceAccountApp();
    for (const email of [ADMIN, OTHER_ADMIN, PERSON]) {
      await resolveViewerUser(email);
    }
    await setUserAdminFromSql(getDb(), ADMIN, true);
    await setUserAdminFromSql(getDb(), OTHER_ADMIN, true);
  });

  afterEach(async () => {
    process.env = { ...ORIGINAL_ENV };
    await closeDb();
  });

  it("lets an admin connect and disconnect a plugin service account from the dashboard", async () => {
    useServiceAccountMcpServer();
    const admin = authenticatedApi(ADMIN);
    const otherAdmin = authenticatedApi(OTHER_ADMIN);
    const person = authenticatedApi(PERSON);

    // Whoever signs in picks the account everyone falls back to.
    expect(
      (await person.request(`${BASE_URL}/api/service-accounts`)).status,
    ).toBe(403);
    expect(
      (
        await person.request(`${BASE_URL}/api/service-accounts/docs-mcp`, {
          method: "POST",
        })
      ).status,
    ).toBe(403);

    expect(await listServiceAccounts(admin)).toEqual([
      {
        connected: false,
        displayName: "Docs",
        userOAuth: true,
        tools: ["search"],
        operations: [],
        provider: "docs-mcp",
      },
      expect.objectContaining({ provider: "clips" }),
    ]);

    const authorization = await startSignIn(admin);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${BASE_URL}/api/service-accounts/docs-mcp/callback`,
    );

    // Only the admin who started the sign-in can finish it.
    expect((await finishSignIn(otherAdmin, authorization)).status).toBe(400);
    const connected = await finishSignIn(admin, authorization);
    expect(connected.status).toBe(200);
    expect(await connected.text()).toContain("service account connected");
    expect(await listServiceAccounts(admin)).toEqual([
      expect.objectContaining({
        connected: true,
        connectedBy: ADMIN,
        provider: "docs-mcp",
      }),
      expect.objectContaining({ connected: false, provider: "clips" }),
    ]);
    // A sign-in is single use.
    expect((await finishSignIn(admin, authorization)).status).toBe(400);

    const disconnected = await admin.request(
      `${BASE_URL}/api/service-accounts/docs-mcp`,
      { method: "DELETE" },
    );
    expect(disconnected.status).toBe(200);
    expect(await listServiceAccounts(admin)).toEqual([
      expect.objectContaining({ connected: false, provider: "docs-mcp" }),
      expect.objectContaining({ connected: false, provider: "clips" }),
    ]);
  });

  it("serves only listed host operations with an OAuth plugin's service account", async () => {
    process.env["CLIPS_CLIENT_ID"] = "clips-client";
    process.env["CLIPS_CLIENT_SECRET"] = "clips-secret";
    const tokenRequests: Array<{ authorization: string | null; body: string }> =
      [];
    const upstream: Array<string | null> = [];
    mswServer.use(
      http.post(
        "https://clips.test/oauth/access_token",
        async ({ request }) => {
          tokenRequests.push({
            authorization: request.headers.get("authorization"),
            body: await request.text(),
          });
          // Like Vimeo: no refresh token and no expiry.
          return HttpResponse.json({
            access_token: "shared-token",
            token_type: "bearer",
            scope: "public upload",
          });
        },
      ),
      http.post("https://api.clips.test/videos", ({ request }) => {
        upstream.push(request.headers.get("authorization"));
        return HttpResponse.json({ uri: "/videos/1" });
      }),
    );
    const admin = authenticatedApi(ADMIN);

    const authorization = await startSignIn(admin, "clips");
    expect(authorization.origin + authorization.pathname).toBe(
      "https://clips.test/oauth/authorize",
    );
    expect(Object.fromEntries(authorization.searchParams)).toMatchObject({
      client_id: "clips-client",
      redirect_uri: `${BASE_URL}/api/service-accounts/clips/callback`,
      response_type: "code",
      scope: "public upload",
    });
    const connected = await finishSignIn(admin, authorization, "clips-code");
    expect(connected.status).toBe(200);
    expect(tokenRequests).toEqual([
      {
        authorization: `Basic ${Buffer.from("clips-client:clips-secret").toString("base64")}`,
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "clips-code",
          redirect_uri: `${BASE_URL}/api/service-accounts/clips/callback`,
        }).toString(),
      },
    ]);
    expect(await listServiceAccounts(admin)).toContainEqual({
      connected: true,
      connectedAt: expect.any(String),
      connectedBy: ADMIN,
      displayName: "Clips",
      operations: ["clips.upload"],
      provider: "clips",
      tools: [],
      userOAuth: false,
    });

    const handleAuthRequired = vi.fn();
    const egress = createPluginEgress({
      credentialContext: { actor: { type: "user", userId: "U_PERSON" } },
      pluginAuth: { handleAuthRequired },
    });
    const post = async (operation: string) =>
      await egress.fetch({
        operation,
        provider: "clips",
        request: new Request("https://api.clips.test/videos", {
          method: "POST",
        }),
      });

    expect((await post("clips.upload")).status).toBe(200);
    expect(upstream).toEqual(["Bearer shared-token"]);
    // An operation the account does not list never gets the token, and the
    // person is not asked to connect their own account.
    expect((await post("clips.delete")).status).toBe(401);
    expect(upstream).toHaveLength(1);
    expect(handleAuthRequired).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unavailable", provider: "clips" }),
    );
  });
});
