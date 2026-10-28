import path from "node:path";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAppFixture,
  type PluginAppFixture,
} from "../../fixtures/plugin-app";
import {
  mcpHandshakeResponse,
  type McpJsonRpcMessage,
} from "../../msw/handlers/mcp-handshake";
import { mswServer } from "../../msw/server";

const PLUGIN_ROOT = path.resolve(
  import.meta.dirname,
  "../../fixtures/plugins/oauth-client-mcp",
);
const PROVIDER = "oauth-client-mcp";
const ORIGIN = "https://oauth-client-mcp.example.test";
const MCP_URL = `${ORIGIN}/mcp`;
const AUTH_ORIGIN = "https://auth.oauth-client-mcp.example.test";
const CLIENT_ID = "pre-registered-client";
const CLIENT_SECRET = "pre-registered-secret";
const AUTHORIZATION_CODE = "authorization-code";
const ACCESS_TOKEN = "access-token";

const ORIGINAL_ENV = { ...process.env };

/**
 * Serve an MCP server whose authorization server has no registration endpoint
 * and advertises a write scope that the plugin must not request.
 */
function useOAuthClientMcpServer() {
  const tokenRequests: Request[] = [];
  let accessToken: string | undefined = ACCESS_TOKEN;
  let refreshToken = "refresh-token";
  mswServer.use(
    http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
    http.post(MCP_URL, async ({ request }) => {
      if (
        !accessToken ||
        request.headers.get("authorization") !== `Bearer ${accessToken}`
      ) {
        return new HttpResponse(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      return mcpHandshakeResponse(
        (await request.json()) as McpJsonRpcMessage,
        PROVIDER,
      );
    }),
    http.get(
      `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
      () =>
        new HttpResponse("OAuth metadata moved", {
          status: 307,
          headers: { location: "/oauth-resource-metadata" },
        }),
    ),
    http.get(`${ORIGIN}/oauth-resource-metadata`, () =>
      HttpResponse.json({
        resource: MCP_URL,
        authorization_servers: [AUTH_ORIGIN],
        scopes_supported: ["docs", "docs.readonly"],
      }),
    ),
    http.get(`${AUTH_ORIGIN}/.well-known/oauth-authorization-server`, () =>
      HttpResponse.json({
        issuer: AUTH_ORIGIN,
        authorization_endpoint: `${AUTH_ORIGIN}/authorize`,
        token_endpoint: `${AUTH_ORIGIN}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      }),
    ),
    http.post(
      `${AUTH_ORIGIN}/token`,
      () =>
        new HttpResponse("Token endpoint moved", {
          status: 307,
          headers: { location: "/token/exchange" },
        }),
    ),
    http.post(`${AUTH_ORIGIN}/token/exchange`, async ({ request }) => {
      tokenRequests.push(request.clone());
      const params = new URLSearchParams(await request.text());
      const clientAuth = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
      const refreshing = params.get("grant_type") === "refresh_token";
      if (
        request.headers.get("authorization") !== clientAuth ||
        (refreshing
          ? params.get("refresh_token") !== refreshToken
          : params.get("code") !== AUTHORIZATION_CODE)
      ) {
        return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
      }
      if (refreshing) {
        accessToken = "refreshed-access-token";
        refreshToken = "rotated-refresh-token";
      }
      return HttpResponse.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
      });
    }),
  );
  return {
    tokenRequests,
    expireAccessToken: () => {
      accessToken = undefined;
    },
  };
}

describe("pre-registered MCP OAuth client", () => {
  let pluginApp: PluginAppFixture | undefined;

  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://junior.example.com",
      OAUTH_CLIENT_MCP_CLIENT_ID: CLIENT_ID,
      OAUTH_CLIENT_MCP_CLIENT_SECRET: CLIENT_SECRET,
    };
    pluginApp = await createPluginAppFixture([PLUGIN_ROOT]);
    vi.resetModules();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    await pluginApp?.cleanup();
    pluginApp = undefined;
    process.env = { ...ORIGINAL_ENV };
  });

  it("authorizes and refreshes with the configured client and a separate authorization server", async () => {
    const server = useOAuthClientMcpServer();
    const { getMcpAuthSession, getMcpStoredOAuthCredentials } =
      await import("@/chat/mcp/auth-store");
    const { McpAuthorizationRequiredError, PluginMcpClient } =
      await import("@/chat/mcp/client");
    const { createMcpOAuthClientProvider, finalizeMcpAuthorization } =
      await import("@/chat/mcp/oauth");
    const { pluginCatalogRuntime } =
      await import("@/chat/plugins/catalog-runtime");
    const plugin = pluginCatalogRuntime.getDefinition(PROVIDER);
    if (!plugin) throw new Error(`Missing ${PROVIDER} fixture plugin`);
    const connect = async () =>
      new PluginMcpClient(plugin, {
        authProvider: await createMcpOAuthClientProvider({
          provider: PROVIDER,
          conversationId: "conversation-1",
          sessionId: "turn-1",
          userId: "U123",
          userMessage: "read my doc",
        }),
      });

    const authProvider = await createMcpOAuthClientProvider({
      provider: PROVIDER,
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userId: "U123",
      userMessage: "read my doc",
    });
    const unauthorized = new PluginMcpClient(plugin, { authProvider });
    try {
      await expect(unauthorized.listTools()).rejects.toBeInstanceOf(
        McpAuthorizationRequiredError,
      );
    } finally {
      await unauthorized.close();
    }

    const session = await getMcpAuthSession(authProvider.authSessionId);
    const authorizationUrl = new URL(session?.authorizationUrl ?? "");
    expect(authorizationUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorizationUrl.searchParams.get("scope")).toBe("docs.readonly");
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");

    await finalizeMcpAuthorization(
      PROVIDER,
      authProvider.authSessionId,
      AUTHORIZATION_CODE,
    );
    expect(server.tokenRequests).toHaveLength(1);

    const authorized = await connect();
    try {
      const tools = await authorized.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["status"]);
    } finally {
      await authorized.close();
    }

    // A new turn must use the saved refresh token without another sign-in.
    server.expireAccessToken();
    const refreshed = await connect();
    try {
      const tools = await refreshed.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["status"]);
    } finally {
      await refreshed.close();
    }
    expect(server.tokenRequests).toHaveLength(2);
    const refreshRequest = server.tokenRequests[1]!;
    expect(refreshRequest.url).toBe(`${AUTH_ORIGIN}/token/exchange`);
    expect(refreshRequest.headers.get("authorization")).toBe(
      `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`,
    );
    const params = new URLSearchParams(await refreshRequest.text());
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-token");
    expect(params.get("resource")).toBe(MCP_URL);
    expect(
      (await getMcpStoredOAuthCredentials("U123", PROVIDER))?.tokens,
    ).toMatchObject({
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      issuer: AUTH_ORIGIN,
    });
  });
});
