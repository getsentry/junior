import { http, HttpResponse } from "msw";

export const EVAL_MCP_AUTH_PROVIDER = "eval-auth";
export const EVAL_MCP_AUTH_CODE = "eval-auth-code";
export const EVAL_MCP_AUTH_ORIGIN = "https://eval-auth.example.test";
export const EVAL_MCP_SERVER_URL = `${EVAL_MCP_AUTH_ORIGIN}/mcp`;
const EVAL_MCP_RESOURCE_METADATA_URL = `${EVAL_MCP_AUTH_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const EVAL_MCP_AUTHORIZATION_ENDPOINT = `${EVAL_MCP_AUTH_ORIGIN}/oauth/authorize`;
const EVAL_MCP_TOKEN_ENDPOINT = `${EVAL_MCP_AUTH_ORIGIN}/oauth/token`;
const EVAL_MCP_REGISTRATION_ENDPOINT = `${EVAL_MCP_AUTH_ORIGIN}/oauth/register`;
const EVAL_MCP_ACCESS_TOKEN = "eval-auth-access-token";
const EVAL_MCP_SESSION_ID = "eval-auth-session";

function unauthorizedResponse() {
  return new HttpResponse(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${EVAL_MCP_RESOURCE_METADATA_URL}", scope="mcp:read"`,
    },
  });
}

function jsonRpcResult(id: unknown, result: unknown, headers?: HeadersInit) {
  return HttpResponse.json(
    {
      jsonrpc: "2.0",
      id,
      result,
    },
    {
      headers,
    },
  );
}

export function resetEvalMcpAuthMockState(): void {}

export const evalMcpAuthHandlers = [
  http.get(
    EVAL_MCP_SERVER_URL,
    async () => new HttpResponse(null, { status: 405 }),
  ),
  http.post(EVAL_MCP_SERVER_URL, async ({ request }) => {
    const authorization = request.headers.get("authorization");
    if (authorization !== `Bearer ${EVAL_MCP_ACCESS_TOKEN}`) {
      return unauthorizedResponse();
    }

    const payload = (await request.json()) as
      | { id?: unknown; method?: unknown; params?: Record<string, unknown> }
      | Array<{
          id?: unknown;
          method?: unknown;
          params?: Record<string, unknown>;
        }>;
    const message = Array.isArray(payload) ? payload[0] : payload;
    const method =
      message && typeof message.method === "string"
        ? message.method
        : undefined;

    switch (method) {
      case "initialize":
        return jsonRpcResult(
          message?.id ?? null,
          {
            protocolVersion: "2025-03-26",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "eval-auth-mcp",
              version: "1.0.0",
            },
          },
          {
            "mcp-session-id": EVAL_MCP_SESSION_ID,
          },
        );
      case "tools/list":
        return jsonRpcResult(message?.id ?? null, {
          tools: [
            {
              name: "budget-echo",
              title: "Budget Echo",
              description:
                "Confirms the MCP connection for the auth-resume eval.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
                additionalProperties: false,
              },
            },
          ],
        });
      case "tools/call": {
        const args =
          message?.params &&
          typeof message.params === "object" &&
          message.params.arguments &&
          typeof message.params.arguments === "object"
            ? (message.params.arguments as Record<string, unknown>)
            : undefined;
        const query = typeof args?.query === "string" ? args.query : "unknown";
        return jsonRpcResult(message?.id ?? null, {
          content: [
            {
              type: "text",
              text: `Eval MCP connection confirmed for: ${query}`,
            },
          ],
          isError: false,
        });
      }
      case "notifications/initialized":
        return new HttpResponse(null, {
          status: 202,
          headers: {
            "mcp-session-id": EVAL_MCP_SESSION_ID,
          },
        });
      default:
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: message?.id ?? null,
            error: {
              code: -32601,
              message: `Unsupported eval MCP method: ${String(method)}`,
            },
          },
          { status: 400 },
        );
    }
  }),
  http.get(EVAL_MCP_RESOURCE_METADATA_URL, async () =>
    HttpResponse.json({
      resource: EVAL_MCP_SERVER_URL,
      authorization_servers: [EVAL_MCP_AUTH_ORIGIN],
      scopes_supported: ["mcp:read"],
    }),
  ),
  http.get(
    `${EVAL_MCP_AUTH_ORIGIN}/.well-known/oauth-authorization-server`,
    async () =>
      HttpResponse.json({
        issuer: EVAL_MCP_AUTH_ORIGIN,
        authorization_endpoint: EVAL_MCP_AUTHORIZATION_ENDPOINT,
        token_endpoint: EVAL_MCP_TOKEN_ENDPOINT,
        registration_endpoint: EVAL_MCP_REGISTRATION_ENDPOINT,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      }),
  ),
  http.post(EVAL_MCP_REGISTRATION_ENDPOINT, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      client_id: "eval-auth-client-id",
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(Array.isArray(body.redirect_uris)
        ? { redirect_uris: body.redirect_uris }
        : {
            redirect_uris: [
              "https://junior.example.com/api/oauth/callback/mcp/eval-auth",
            ],
          }),
      ...(Array.isArray(body.grant_types)
        ? { grant_types: body.grant_types }
        : { grant_types: ["authorization_code", "refresh_token"] }),
      ...(Array.isArray(body.response_types)
        ? { response_types: body.response_types }
        : { response_types: ["code"] }),
      ...(typeof body.client_name === "string"
        ? { client_name: body.client_name }
        : { client_name: "Junior MCP Client" }),
      token_endpoint_auth_method: "none",
    });
  }),
  http.post(EVAL_MCP_TOKEN_ENDPOINT, async ({ request }) => {
    const bodyText = await request.text();
    const params = new URLSearchParams(bodyText);
    const code = params.get("code");
    if (code !== EVAL_MCP_AUTH_CODE) {
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: `Unexpected code: ${code ?? "<missing>"}`,
        },
        { status: 400 },
      );
    }

    return HttpResponse.json({
      access_token: EVAL_MCP_ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "eval-auth-refresh-token",
      scope: "mcp:read",
    });
  }),
];
