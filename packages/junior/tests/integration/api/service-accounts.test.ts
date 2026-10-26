import { Hono } from "hono";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJuniorApi, type JuniorApiVariables } from "@/api";
import { serviceAccountListSchema } from "@/api/schema";
import { closeDb, getDb } from "@/chat/db";
import { resolveViewerUser, setUserAdminFromSql } from "@/chat/plugins/viewer";
import {
  SERVICE_ACCOUNT_MCP_CODE,
  SERVICE_ACCOUNT_MCP_URL,
  useServiceAccountMcpServer,
} from "../../fixtures/service-account-mcp";

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
          serviceAccount: { mcpTools: ["search"] },
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

async function startSignIn(app: ReturnType<typeof authenticatedApi>) {
  const response = await app.request(
    `${BASE_URL}/api/service-accounts/docs-mcp`,
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
) {
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  callback.searchParams.set("code", SERVICE_ACCOUNT_MCP_CODE);
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
        mcpTools: ["search"],
        provider: "docs-mcp",
      },
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
    ]);
  });
});
