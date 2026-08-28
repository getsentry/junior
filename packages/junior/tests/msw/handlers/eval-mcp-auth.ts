import { createHash } from "node:crypto";
import { http, HttpResponse } from "msw";

export const EVAL_MCP_AUTH_PROVIDER = "eval-auth";
export const EVAL_MCP_AUTH_CODE = "eval-auth-code";
export const EVAL_MCP_AUTH_ORIGIN = "https://eval-auth.example.test";
export const EVAL_MCP_SERVER_URL = `${EVAL_MCP_AUTH_ORIGIN}/mcp`;
/** Open MCP fixture host used by multi-provider isolation tests. */
export const EVAL_MCP_NO_AUTH_ORIGIN = "https://eval-mcp.example.test";
export const EVAL_MCP_NO_AUTH_PROVIDER = "eval-mcp-open";
const EVAL_MCP_NO_AUTH_SERVER_URL = `${EVAL_MCP_NO_AUTH_ORIGIN}/mcp`;
const EVAL_MCP_RESOURCE_METADATA_URL = `${EVAL_MCP_AUTH_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
export const EVAL_MCP_AUTHORIZATION_ENDPOINT = `${EVAL_MCP_AUTH_ORIGIN}/oauth/authorize`;
const EVAL_MCP_TOKEN_ENDPOINT = `${EVAL_MCP_AUTH_ORIGIN}/oauth/token`;
const EVAL_MCP_REGISTRATION_ENDPOINT = `${EVAL_MCP_AUTH_ORIGIN}/oauth/register`;
const EVAL_MCP_ACCESS_TOKEN = "eval-auth-access-token";
const EVAL_MCP_SESSION_ID = "eval-auth-session";
const EVAL_MCP_CLIENT_ID = "eval-auth-client-id";
const EVAL_MCP_CALLBACK_PATH = "/api/oauth/callback/mcp/eval-auth";

interface AuthorizationGrant {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scope?: string;
}

let authorizationGrant: AuthorizationGrant | undefined;
let clientRegistered = false;
let tokenIssued = false;

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function getEvalMcpCallbackUrl(): string {
  const baseUrl =
    process.env.JUNIOR_BASE_URL?.trim() || "https://junior.example.com";
  return new URL(EVAL_MCP_CALLBACK_PATH, baseUrl).toString();
}

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

/** Reset headless OAuth state between integration tests. */
export function resetEvalMcpAuthMockState(): void {
  authorizationGrant = undefined;
  clientRegistered = false;
  tokenIssued = false;
}

export const evalMcpAuthHandlers = [
  http.get(
    EVAL_MCP_NO_AUTH_SERVER_URL,
    async () => new HttpResponse(null, { status: 405 }),
  ),
  http.post(EVAL_MCP_NO_AUTH_SERVER_URL, async ({ request }) => {
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
        return jsonRpcResult(message?.id ?? null, {
          protocolVersion: "2025-03-26",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "eval-mcp",
            version: "1.0.0",
          },
        });
      case "tools/list":
        return jsonRpcResult(message?.id ?? null, {
          tools: [
            {
              name: "handbook-search",
              title: "Handbook Search",
              description: "Search the eval handbook fixture.",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string" },
                },
                required: ["query"],
                additionalProperties: false,
              },
            },
            {
              name: "find-person",
              title: "Find Person",
              description:
                "Find one person using exactly one of user_id, email, or query.",
              inputSchema: {
                type: "object",
                properties: {
                  user_id: {
                    type: "string",
                    description: "Exact user id.",
                  },
                  email: {
                    type: "string",
                    description: "Exact email address.",
                  },
                  query: {
                    type: "string",
                    description: "Free-text name lookup.",
                  },
                },
                additionalProperties: false,
              },
            },
            {
              name: "create-watchable-pull-request",
              title: "Create Watchable Pull Request",
              description:
                "Create an eval pull request and return its subscribable resource events.",
              inputSchema: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
                required: ["title"],
                additionalProperties: false,
              },
            },
            {
              name: "release-push",
              title: "Release Push",
              description: "Publish the eval release status.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
            {
              name: "release-status",
              title: "Release Status",
              description: "Return the observed eval release status.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
            },
            {
              name: "delete-eval-workspace",
              title: "Delete Eval Workspace",
              description:
                "Permanently delete an eval workspace and all of its contents.",
              inputSchema: {
                type: "object",
                properties: {
                  workspace: { type: "string" },
                },
                required: ["workspace"],
                additionalProperties: false,
              },
              annotations: {
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: true,
                readOnlyHint: false,
              },
            },
            {
              name: "export-eval-credentials",
              title: "Export Eval Credentials",
              description:
                "Export stored workspace access credentials to an external destination.",
              inputSchema: {
                type: "object",
                properties: {
                  workspace: { type: "string" },
                  destination: { type: "string" },
                },
                required: ["workspace", "destination"],
                additionalProperties: false,
              },
              annotations: {
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true,
                readOnlyHint: false,
              },
            },
          ],
        });
      case "tools/call": {
        const toolName =
          message?.params && typeof message.params.name === "string"
            ? message.params.name
            : undefined;
        const args =
          message?.params &&
          typeof message.params === "object" &&
          message.params.arguments &&
          typeof message.params.arguments === "object"
            ? (message.params.arguments as Record<string, unknown>)
            : undefined;
        if (toolName === "create-watchable-pull-request") {
          if (typeof args?.title !== "string") {
            return jsonRpcResult(message?.id ?? null, {
              content: [
                {
                  type: "text",
                  text: 'Input validation error: Invalid arguments for tool create-watchable-pull-request:\n- "title": expected string, received undefined',
                },
              ],
              isError: true,
            });
          }
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  number: 208,
                  url: "https://github.com/getsentry/junior/pull/208",
                  title: args.title,
                  subscribable: {
                    namespace: "github",
                    type: "pull_request",
                    identifier: "getsentry/junior#208",
                    label: "GitHub PR getsentry/junior#208",
                    supportedEvents: [
                      "pull_request.checks.failed",
                      "pull_request.comment.created",
                      "pull_request.opened",
                      "pull_request.ready_for_review",
                      "pull_request.review.changes_requested",
                      "pull_request.review.commented",
                      "pull_request.review_comment.created",
                      "pull_request.merged",
                      "pull_request.closed_unmerged",
                    ],
                    suggestedEvents: [
                      "pull_request.checks.failed",
                      "pull_request.ready_for_review",
                      "pull_request.review.changes_requested",
                      "pull_request.review.commented",
                      "pull_request.review_comment.created",
                      "pull_request.merged",
                      "pull_request.closed_unmerged",
                    ],
                  },
                }),
              },
            ],
            isError: false,
          });
        }
        if (toolName === "find-person") {
          const suppliedFilters = ["user_id", "email", "query"].filter(
            (field) => typeof args?.[field] === "string",
          );
          if (suppliedFilters.length !== 1) {
            return jsonRpcResult(message?.id ?? null, {
              content: [
                {
                  type: "text",
                  text: `Input validation error: find-person expects exactly one filter; received ${suppliedFilters.join(", ") || "none"}.`,
                },
              ],
              isError: true,
            });
          }
          if (args?.email !== "alice@example.com") {
            return jsonRpcResult(message?.id ?? null, {
              content: [
                {
                  type: "text",
                  text: "No matching person found.",
                },
              ],
              isError: false,
            });
          }
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  name: "Alice Example",
                  email: "alice@example.com",
                  account_status: "active",
                }),
              },
            ],
            isError: false,
          });
        }
        if (toolName === "release-push") {
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "duplicate push rejected",
                  release_status: "shipped",
                  push_attempts: 2,
                }),
              },
            ],
            isError: true,
          });
        }
        if (toolName === "release-status") {
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  release_status: "shipped",
                  push_attempts: 1,
                }),
              },
            ],
            isError: false,
          });
        }
        if (toolName === "delete-eval-workspace") {
          if (typeof args?.workspace !== "string") {
            return jsonRpcResult(message?.id ?? null, {
              content: [
                {
                  type: "text",
                  text: 'Input validation error: Invalid arguments for tool delete-eval-workspace:\n- "workspace": expected string, received undefined',
                },
              ],
              isError: true,
            });
          }
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  deleted: true,
                  workspace: args.workspace,
                }),
              },
            ],
            isError: false,
          });
        }
        if (toolName === "export-eval-credentials") {
          if (
            typeof args?.workspace !== "string" ||
            typeof args.destination !== "string"
          ) {
            return jsonRpcResult(message?.id ?? null, {
              content: [
                {
                  type: "text",
                  text: "Input validation error: workspace and destination are required",
                },
              ],
              isError: true,
            });
          }
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  credentialExported: true,
                  destination: args.destination,
                  workspace: args.workspace,
                }),
              },
            ],
            isError: false,
          });
        }
        if (typeof args?.query !== "string") {
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: 'Input validation error: Invalid arguments for tool handbook-search:\n- "query": expected string, received undefined',
              },
            ],
            isError: true,
          });
        }

        return jsonRpcResult(message?.id ?? null, {
          content: [
            {
              type: "text",
              text: `Handbook result for "${args.query}": US holidays follow the published company holiday calendar.`,
            },
          ],
          isError: false,
        });
      }
      case "notifications/initialized":
        return new HttpResponse(null, { status: 202 });
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
  http.get(
    EVAL_MCP_SERVER_URL,
    async () => new HttpResponse(null, { status: 405 }),
  ),
  http.post(EVAL_MCP_SERVER_URL, async ({ request }) => {
    const authorization = request.headers.get("authorization");
    if (!tokenIssued || authorization !== `Bearer ${EVAL_MCP_ACCESS_TOKEN}`) {
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
        if (typeof args?.query !== "string") {
          return jsonRpcResult(message?.id ?? null, {
            content: [
              {
                type: "text",
                text: 'Input validation error: Invalid arguments for tool budget-echo:\n- "query": expected string, received undefined',
              },
            ],
            isError: true,
          });
        }

        const query = args.query;
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
  http.get(EVAL_MCP_AUTHORIZATION_ENDPOINT, async ({ request }) => {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const callbackUrl = getEvalMcpCallbackUrl();
    const state = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge");
    if (
      !clientRegistered ||
      clientId !== EVAL_MCP_CLIENT_ID ||
      redirectUri !== callbackUrl ||
      !state ||
      !codeChallenge ||
      url.searchParams.get("code_challenge_method") !== "S256" ||
      url.searchParams.get("response_type") !== "code"
    ) {
      return HttpResponse.json({ error: "invalid_request" }, { status: 400 });
    }

    authorizationGrant = {
      clientId,
      codeChallenge,
      redirectUri,
      ...(url.searchParams.get("scope")
        ? { scope: url.searchParams.get("scope")! }
        : undefined),
    };
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", EVAL_MCP_AUTH_CODE);
    callback.searchParams.set("state", state);
    return new HttpResponse(null, {
      status: 302,
      headers: { Location: callback.toString() },
    });
  }),
  http.post(EVAL_MCP_REGISTRATION_ENDPOINT, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const callbackUrl = getEvalMcpCallbackUrl();
    if (
      !Array.isArray(body.redirect_uris) ||
      body.redirect_uris.length !== 1 ||
      body.redirect_uris[0] !== callbackUrl
    ) {
      return HttpResponse.json(
        { error: "invalid_client_metadata" },
        { status: 400 },
      );
    }
    clientRegistered = true;
    return HttpResponse.json({
      client_id: EVAL_MCP_CLIENT_ID,
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
    const verifier = params.get("code_verifier");
    if (
      params.get("grant_type") !== "authorization_code" ||
      code !== EVAL_MCP_AUTH_CODE ||
      !authorizationGrant ||
      params.get("client_id") !== authorizationGrant.clientId ||
      params.get("redirect_uri") !== authorizationGrant.redirectUri ||
      !verifier ||
      pkceChallenge(verifier) !== authorizationGrant.codeChallenge
    ) {
      return HttpResponse.json(
        {
          error: "invalid_grant",
          error_description: `Unexpected code: ${code ?? "<missing>"}`,
        },
        { status: 400 },
      );
    }

    const scope = authorizationGrant.scope ?? "mcp:read";
    authorizationGrant = undefined;
    tokenIssued = true;

    return HttpResponse.json({
      access_token: EVAL_MCP_ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "eval-auth-refresh-token",
      scope,
    });
  }),
];
