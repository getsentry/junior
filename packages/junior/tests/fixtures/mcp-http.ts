import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { vi } from "vitest";
import { createApp } from "@/app";
import type { AuthenticatedRoute } from "@/dashboard-routes";
import { resolveViewerUser } from "@/chat/plugins/viewer";
import { MCP_CLIENT_ID } from "../msw/handlers/mcp-client-metadata";

export const MCP_TEST_ORIGIN = "http://junior.test";
export const MCP_TEST_URL = `${MCP_TEST_ORIGIN}/api/mcp`;
export const MCP_TEST_ALLOWED_DOMAINS = ["example.com"];
export const MCP_TEST_VIEWER = "mcp-viewer@example.com";
export const MCP_TEST_OTHER_VIEWER = "mcp-other@example.com";
// Claude Code listens on a random loopback port.
export const MCP_TEST_REDIRECT_URI = "http://127.0.0.1:53682/callback";
/** Cookie that the fake dashboard reads in place of a Google sign-in session. */
const TEST_VIEWER_COOKIE = "junior_test_viewer";

/**
 * Supply a dashboard whose sign-in is faked. Authenticated routes receive the
 * user named by the test viewer cookie, as the real dashboard passes the
 * Google-verified user. Requests without the cookie get 401.
 */
export function mockMcpDashboardConfig(): void {
  vi.doMock("#junior/config", () => ({
    createDashboardApp: (options: {
      authenticatedRoutes?: readonly AuthenticatedRoute[];
    }) => {
      const app = new Hono();
      for (const route of options.authenticatedRoutes ?? []) {
        app.on(["GET", "POST"], route.path, async (c) => {
          const email = c.req
            .header("cookie")
            ?.match(new RegExp(`${TEST_VIEWER_COOKIE}=([^;]+)`))?.[1];
          if (!email) return new Response("Unauthorized", { status: 401 });
          const user = await resolveViewerUser(decodeURIComponent(email));
          if (!user) throw new Error("MCP test viewer could not be resolved");
          return await route.handler(c.req.raw, user);
        });
      }
      return app;
    },
    dashboard: { baseURL: MCP_TEST_ORIGIN },
    functionMaxDurationSeconds: undefined,
    pluginSet: undefined,
    plugins: undefined,
    pluginRuntimeRegistrations: [],
  }));
}

/** Build the cookie header that signs one viewer in to the fake dashboard. */
export function viewerCookie(email: string): string {
  return `${TEST_VIEWER_COOKIE}=${encodeURIComponent(email)}`;
}

/** Run one callback with the official MCP SDK client and an access token. */
export async function withMcpClient<T>(
  app: Hono,
  accessToken: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: "junior-mcp-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_TEST_URL), {
    fetch: async (input, init) => await app.fetch(new Request(input, init)),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

export type McpTokenBody = {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  token_type: string;
};

/** Create one RFC 7636 PKCE verifier and its S256 challenge. */
export function createPkce(): { challenge: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  return {
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    verifier,
  };
}

/** Build an MCP authorization request URL with valid defaults. */
export function mcpAuthorizeUrl(params: Record<string, string>): string {
  const url = new URL(`${MCP_TEST_ORIGIN}/api/mcp/oauth/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    code_challenge_method: "S256",
    scope: "conversations:read",
    resource: MCP_TEST_URL,
    ...params,
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

/** Open the consent page as one viewer and return its form token. */
export async function openMcpConsentPage(
  app: Hono,
  consentUrl: string,
  email: string,
): Promise<{
  csrf?: string | undefined;
  html: string;
  referrerPolicy: string | null;
  status: number;
}> {
  const response = await app.request(consentUrl, {
    headers: { cookie: viewerCookie(email) },
  });
  const html = await response.text();
  return {
    csrf: html.match(/name="csrf" value="([^"]+)"/)?.[1],
    html,
    referrerPolicy: response.headers.get("referrer-policy"),
    status: response.status,
  };
}

/**
 * Approve consent as the viewer who opened the page. The `Origin` header
 * follows the page's referrer policy the way a browser form POST does: under
 * `no-referrer`, browsers send `Origin: null`.
 */
export async function approveMcpConsent(
  app: Hono,
  args: {
    consentUrl: string;
    csrf: string;
    email: string;
    referrerPolicy: string | null;
  },
): Promise<Response> {
  return await app.request(args.consentUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: viewerCookie(args.email),
      origin: args.referrerPolicy === "no-referrer" ? "null" : MCP_TEST_ORIGIN,
    },
    body: new URLSearchParams({ action: "approve", csrf: args.csrf }),
  });
}

/** POST one form-encoded request to the MCP token endpoint. */
export async function requestMcpTokens(
  app: Hono,
  params: Record<string, string>,
): Promise<Response> {
  return await app.request(`${MCP_TEST_ORIGIN}/api/mcp/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
}

/** Approve the test client as one viewer and return its code and verifier. */
export async function approveMcpClient(
  app: Hono,
  email: string,
  scope = "conversations:read",
): Promise<{ code: string; consentHtml: string; verifier: string }> {
  const pkce = createPkce();
  const authorize = await app.request(
    mcpAuthorizeUrl({
      client_id: MCP_CLIENT_ID,
      code_challenge: pkce.challenge,
      redirect_uri: MCP_TEST_REDIRECT_URI,
      scope,
    }),
  );
  const consentUrl = authorize.headers.get("location") ?? "";
  const page = await openMcpConsentPage(app, consentUrl, email);
  const approved = await approveMcpConsent(app, {
    consentUrl,
    csrf: page.csrf ?? "",
    email,
    referrerPolicy: page.referrerPolicy,
  });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error("MCP consent returned no code");
  return { code, consentHtml: page.html, verifier: pkce.verifier };
}

/** Exchange an authorization code for MCP tokens. */
export function exchangeMcpCode(
  app: Hono,
  args: { code: string; verifier: string },
): Promise<Response> {
  return requestMcpTokens(app, {
    client_id: MCP_CLIENT_ID,
    code: args.code,
    code_verifier: args.verifier,
    grant_type: "authorization_code",
    redirect_uri: MCP_TEST_REDIRECT_URI,
    resource: MCP_TEST_URL,
  });
}

/**
 * Connect the test client as one viewer and return its access token. An
 * empty scope asks for every scope.
 */
export async function connectMcpClient(
  app: Hono,
  email: string,
  scope = "",
): Promise<string> {
  const response = await exchangeMcpCode(
    app,
    await approveMcpClient(app, email, scope),
  );
  return ((await response.json()) as McpTokenBody).access_token;
}

/** Call one tool with the official MCP SDK client. */
export async function callMcpTool(
  app: Hono,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return await withMcpClient(app, token, (client) =>
    client.callTool({ name, arguments: args }),
  );
}

/**
 * Connect one viewer to a new app and return a function that calls one
 * tool as that viewer. An empty scope asks for every scope. `appOptions`
 * can swap in test services, such as in-process Conversation work.
 */
export async function connectMcpTools(
  email = MCP_TEST_VIEWER,
  scope = "",
  appOptions: Parameters<typeof createApp>[0] = {},
) {
  const app = await createApp({
    ...appOptions,
    allowedDomains: MCP_TEST_ALLOWED_DOMAINS,
  });
  const token = await connectMcpClient(app, email, scope);
  return (name: string, args: Record<string, unknown> = {}) =>
    callMcpTool(app, token, name, args);
}
