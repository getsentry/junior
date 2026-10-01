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
  mswServer.use(
    http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
    http.post(MCP_URL, async ({ request }) => {
      if (request.headers.get("authorization") !== `Bearer ${ACCESS_TOKEN}`) {
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
    http.get(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, () =>
      HttpResponse.json({
        resource: MCP_URL,
        authorization_servers: [ORIGIN],
        scopes_supported: ["docs", "docs.readonly"],
      }),
    ),
    http.get(`${ORIGIN}/.well-known/oauth-authorization-server`, () =>
      HttpResponse.json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"],
      }),
    ),
    http.post(`${ORIGIN}/token`, async ({ request }) => {
      tokenRequests.push(request.clone());
      const params = new URLSearchParams(await request.text());
      const clientAuth = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
      if (
        request.headers.get("authorization") !== clientAuth ||
        params.get("code") !== AUTHORIZATION_CODE
      ) {
        return HttpResponse.json({ error: "invalid_client" }, { status: 401 });
      }
      return HttpResponse.json({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "refresh-token",
      });
    }),
  );
  return { tokenRequests };
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

  it("authorizes with the configured client and scope instead of registering", async () => {
    const server = useOAuthClientMcpServer();
    const { getMcpAuthSession } = await import("@/chat/mcp/auth-store");
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
  });
});
