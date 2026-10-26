import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mswServer } from "../../msw/server";
import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import {
  deleteMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import {
  connectMcpServiceAccount,
  deleteMcpServiceAccountCredentials,
  getMcpServiceAccountCredentials,
} from "@/chat/mcp/service-account";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import type { PluginDefinition } from "@/chat/plugins/types";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";

const ORIGIN = "https://service-account-mcp.example.test";
const MCP_URL = `${ORIGIN}/mcp`;
const PROVIDER = "docs-mcp";
const AUTHORIZATION_CODE = "service-account-code";
const ACTOR_ID = "U123";

const plugin: PluginDefinition = {
  dir: `/plugins/${PROVIDER}`,
  manifest: {
    name: PROVIDER,
    displayName: "Docs MCP",
    description: "Docs MCP server",
    configKeys: [],
    mcp: {
      transport: "http",
      url: MCP_URL,
      allowedTools: ["search", "create"],
    },
    serviceAccount: { mcpTools: ["search"] },
  },
};

/**
 * Serve an MCP server with dynamic client registration and rotating refresh
 * tokens. Each tool call returns the access token that it received.
 */
function useServiceAccountMcpServer() {
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  let issued = 0;
  const issue = () => {
    issued += 1;
    const tokens = {
      access_token: `access-${issued}`,
      refresh_token: `refresh-${issued}`,
    };
    accessTokens.add(tokens.access_token);
    refreshTokens.add(tokens.refresh_token);
    return HttpResponse.json({
      ...tokens,
      token_type: "Bearer",
      expires_in: 3600,
    });
  };

  mswServer.use(
    http.get(MCP_URL, () => new HttpResponse(null, { status: 405 })),
    http.post(MCP_URL, async ({ request }) => {
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer /, "");
      if (!token || !accessTokens.has(token)) {
        return new HttpResponse(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      const message = (await request.json()) as {
        id?: unknown;
        method: string;
      };
      if (message.method === "notifications/initialized") {
        return new HttpResponse(null, { status: 202 });
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: PROVIDER, version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: ["search", "create"].map((name) => ({
                  name,
                  inputSchema: { type: "object", properties: {} },
                })),
              }
            : { content: [{ type: "text", text: token }] };
      return HttpResponse.json({ jsonrpc: "2.0", id: message.id, result });
    }),
    http.get(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, () =>
      HttpResponse.json({
        resource: MCP_URL,
        authorization_servers: [ORIGIN],
      }),
    ),
    http.get(`${ORIGIN}/.well-known/oauth-authorization-server`, () =>
      HttpResponse.json({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }),
    ),
    http.post(`${ORIGIN}/register`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...body, client_id: "registered-client" });
    }),
    http.post(`${ORIGIN}/token`, async ({ request }) => {
      const params = new URLSearchParams(await request.text());
      if (
        params.get("grant_type") === "authorization_code" &&
        params.get("code") === AUTHORIZATION_CODE
      ) {
        return issue();
      }
      const refreshToken = params.get("refresh_token");
      if (
        params.get("grant_type") === "refresh_token" &&
        refreshToken &&
        refreshTokens.delete(refreshToken)
      ) {
        return issue();
      }
      return HttpResponse.json({ error: "invalid_grant" }, { status: 400 });
    }),
  );

  return {
    expireAccessTokens: () => accessTokens.clear(),
    revokeGrant: () => {
      accessTokens.clear();
      refreshTokens.clear();
    },
  };
}

async function connectServiceAccount(): Promise<void> {
  await connectMcpServiceAccount({
    plugin,
    redirectUrl: "http://127.0.0.1:8765/oauth/callback",
    authorize: async (authorizationUrl) =>
      new URLSearchParams({
        code: AUTHORIZATION_CODE,
        state: authorizationUrl.searchParams.get("state") ?? "",
      }),
  });
}

/** Actor OAuth with no stored tokens, so every call needs authorization. */
function unconnectedActorAuth(): OAuthClientProvider {
  let clientInformation: OAuthClientInformationMixed | undefined;
  return {
    redirectUrl: "https://junior.example.test/api/oauth/callback/mcp/docs-mcp",
    clientMetadata: {
      redirect_uris: [
        "https://junior.example.test/api/oauth/callback/mcp/docs-mcp",
      ],
    },
    clientInformation: () => clientInformation,
    saveClientInformation: (next) => {
      clientInformation = next;
    },
    tokens: () => undefined,
    saveTokens: () => undefined,
    redirectToAuthorization: () => undefined,
    saveCodeVerifier: () => undefined,
    codeVerifier: () => "verifier",
  };
}

function createManager(onAuthorizationRequired = vi.fn()) {
  const mcpAuth = createMcpAuthOrchestration({
    abortAgent: vi.fn(),
    actorId: ACTOR_ID,
    conversationId: "conversation-service-account",
    getConfiguration: () => ({}),
    sessionId: "turn-service-account",
    userMessage: "find the onboarding doc",
  });
  return {
    mcpAuth,
    manager: new McpToolManager([plugin], {
      authProviderFactory: unconnectedActorAuth,
      serviceAccountProviderFactory: mcpAuth.serviceAccountProviderFactory,
      onAuthorizationRequired,
    }),
  };
}

function tool(manager: McpToolManager, rawName: string) {
  const found = manager
    .getResolvedActiveTools({ provider: PROVIDER })
    .find((candidate) => candidate.rawName === rawName);
  if (!found) {
    throw new Error(`missing tool ${rawName}`);
  }
  return found;
}

describe("MCP service account auth", () => {
  beforeEach(async () => {
    await deleteMcpStoredOAuthCredentials(ACTOR_ID, PROVIDER);
    await deleteMcpServiceAccountCredentials(PROVIDER);
  });

  it("reads through the service account and sends other tools to the actor's own connection", async () => {
    useServiceAccountMcpServer();
    await connectServiceAccount();
    const onAuthorizationRequired = vi.fn(async () => false);
    const { manager, mcpAuth } = createManager(onAuthorizationRequired);

    try {
      await manager.activateProvider(PROVIDER);
      await expect(tool(manager, "search").execute({})).resolves.toMatchObject({
        content: [{ type: "text", text: "access-1" }],
      });

      await expect(tool(manager, "create").execute({})).rejects.toBeInstanceOf(
        McpAuthorizationRequiredError,
      );
      expect(onAuthorizationRequired).toHaveBeenCalledWith(
        PROVIDER,
        expect.any(McpAuthorizationRequiredError),
        { toolName: "create" },
      );

      await putMcpStoredOAuthCredentials(ACTOR_ID, PROVIDER, {
        tokens: { access_token: "actor-token", token_type: "Bearer" },
      });
      await expect(
        mcpAuth.serviceAccountProviderFactory(plugin),
      ).resolves.toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it("refreshes the shared token and disconnects once the provider revokes the grant", async () => {
    const server = useServiceAccountMcpServer();
    await connectServiceAccount();

    server.expireAccessTokens();
    const refreshed = createManager().manager;
    try {
      await refreshed.activateProvider(PROVIDER);
      await expect(
        tool(refreshed, "search").execute({}),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "access-2" }],
      });
    } finally {
      await refreshed.close();
    }
    expect(
      (await getMcpServiceAccountCredentials(PROVIDER))?.tokens.refresh_token,
    ).toBe("refresh-2");

    server.revokeGrant();
    const revoked = createManager().manager;
    try {
      const failure = await revoked
        .activateProvider(PROVIDER)
        .catch((error: unknown) => error);
      expect(failure).not.toBeInstanceOf(McpAuthorizationRequiredError);
      expect(failure).toBeInstanceOf(Error);
    } finally {
      await revoked.close();
    }
    await expect(
      getMcpServiceAccountCredentials(PROVIDER),
    ).resolves.toBeUndefined();
  });
});
