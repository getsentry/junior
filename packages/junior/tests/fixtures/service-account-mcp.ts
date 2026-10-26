import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";

const ORIGIN = "https://service-account-mcp.example.test";
/** URL of the fake MCP server that supports a service account. */
export const SERVICE_ACCOUNT_MCP_URL = `${ORIGIN}/mcp`;
const MCP_URL = SERVICE_ACCOUNT_MCP_URL;
const PROVIDER = "docs-mcp";
/** Code that the fake provider accepts at its token endpoint. */
export const SERVICE_ACCOUNT_MCP_CODE = "service-account-code";
const AUTHORIZATION_CODE = SERVICE_ACCOUNT_MCP_CODE;

/**
 * Serve an MCP server with dynamic client registration and rotating refresh
 * tokens. Each tool call returns the access token that it received.
 */
export function useServiceAccountMcpServer() {
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
