import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@/app";
import { createPersonalToken } from "@/personal-tokens/store";
import {
  approveMcpClient,
  approveMcpConsent,
  connectMcpClient,
  createPkce,
  exchangeMcpCode,
  MCP_TEST_ALLOWED_DOMAINS,
  MCP_TEST_ORIGIN,
  MCP_TEST_OTHER_VIEWER,
  MCP_TEST_REDIRECT_URI,
  MCP_TEST_URL,
  MCP_TEST_VIEWER,
  mcpAuthorizeUrl,
  type McpTokenBody,
  mockMcpDashboardConfig,
  openMcpConsentPage,
  requestMcpTokens,
  withMcpClient,
} from "../../../fixtures/mcp-http";
import { seedMcpConversation } from "../../../fixtures/mcp-tools";
import {
  MCP_CLIENT_ID,
  MCP_CLIENT_NAME,
  MCP_MISMATCHED_CLIENT_ID,
} from "../../../msw/handlers/mcp-client-metadata";

const ALL_SCOPES =
  "conversations:read conversations:manage conversations:write review_items:read automations:read";

mockMcpDashboardConfig();

/** Send a raw `tools/list` request with one bearer token. */
async function listTools(app: Hono, token: string): Promise<Response> {
  return await app.request(MCP_TEST_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

function refresh(app: Hono, refreshToken: string): Promise<Response> {
  return requestMcpTokens(app, {
    client_id: MCP_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: MCP_TEST_URL,
  });
}

describe("remote MCP HTTP", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects a CIMD client and lists only the signed-in user's Conversations", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const pkce = createPkce();
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000100",
      email: MCP_TEST_VIEWER,
      title: "Viewer launch plan",
    });
    await seedMcpConversation({
      conversationId: "slack:C123:1700000000.000200",
      email: MCP_TEST_OTHER_VIEWER,
      title: "Other person's roadmap",
    });

    const challenge = await app.request(MCP_TEST_URL, { method: "POST" });
    const resourceMetadataURL = challenge.headers
      .get("www-authenticate")
      ?.match(/resource_metadata="([^"]+)"/)?.[1];
    const resource = await app.request(resourceMetadataURL ?? "");
    const resourceMetadata = (await resource.json()) as {
      authorization_servers: string[];
    };
    const server = await app.request(
      `${resourceMetadata.authorization_servers[0]}/.well-known/oauth-authorization-server`,
    );
    const serverMetadata = (await server.json()) as {
      authorization_endpoint: string;
    };

    const authorize = await app.request(
      `${serverMetadata.authorization_endpoint}?${new URL(
        mcpAuthorizeUrl({
          client_id: MCP_CLIENT_ID,
          code_challenge: pkce.challenge,
          redirect_uri: MCP_TEST_REDIRECT_URI,
          state: "client-state",
        }),
      ).searchParams.toString()}`,
    );
    const consentUrl = authorize.headers.get("location") ?? "";
    const page = await openMcpConsentPage(app, consentUrl, MCP_TEST_VIEWER);
    const otherPage = await openMcpConsentPage(
      app,
      consentUrl,
      MCP_TEST_OTHER_VIEWER,
    );
    const approved = await approveMcpConsent(app, {
      consentUrl,
      csrf: page.csrf ?? "",
      email: MCP_TEST_VIEWER,
      referrerPolicy: page.referrerPolicy,
    });
    const callback = new URL(approved.headers.get("location") ?? "");
    const issued = await exchangeMcpCode(app, {
      code: callback.searchParams.get("code") ?? "",
      verifier: pkce.verifier,
    });
    const tokens = (await issued.json()) as McpTokenBody;
    const listed = await withMcpClient(app, tokens.access_token, (client) =>
      client.callTool({ name: "searchConversations", arguments: {} }),
    );
    const rotated = await refresh(app, tokens.refresh_token);
    const rotatedTokens = (await rotated.json()) as McpTokenBody;
    const rotatedSearch = await withMcpClient(
      app,
      rotatedTokens.access_token,
      (client) =>
        client.callTool({
          name: "searchConversations",
          arguments: { q: "roadmap" },
        }),
    );

    expect(challenge.status).toBe(401);
    expect(resourceMetadata).toEqual({
      resource: MCP_TEST_URL,
      authorization_servers: [MCP_TEST_ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: ALL_SCOPES.split(" "),
    });
    expect(serverMetadata).toEqual({
      issuer: MCP_TEST_ORIGIN,
      authorization_endpoint: `${MCP_TEST_ORIGIN}/api/mcp/oauth/authorize`,
      token_endpoint: `${MCP_TEST_ORIGIN}/api/mcp/oauth/token`,
      scopes_supported: ALL_SCOPES.split(" "),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true,
    });
    expect(page.status).toBe(200);
    expect(page.html).toContain(`Connect ${MCP_CLIENT_NAME}`);
    expect(page.html).toContain("mcp-client.example.test");
    expect(otherPage.status).toBe(403);
    expect(`${callback.origin}${callback.pathname}`).toBe(
      MCP_TEST_REDIRECT_URI,
    );
    expect(callback.searchParams.get("state")).toBe("client-state");
    expect(callback.searchParams.get("iss")).toBe(MCP_TEST_ORIGIN);
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(tokens).toEqual({
      access_token: expect.stringMatching(/^jr_mcp_at_/),
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^jr_mcp_rt_/),
      scope: "conversations:read",
      token_type: "Bearer",
    });
    expect(listed.structuredContent).toEqual({
      conversations: [
        expect.objectContaining({
          conversationId: "slack:C123:1700000000.000100",
        }),
      ],
    });
    expect(rotated.status).toBe(200);
    expect(rotatedTokens.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotatedSearch).toMatchObject({
      structuredContent: { conversations: [] },
    });
  });

  it("rejects a personal token and a token for a domain that is no longer allowed", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const personal = await createPersonalToken({
      email: MCP_TEST_VIEWER,
      name: "MCP rejected token",
    });
    const tokens = (await (
      await exchangeMcpCode(app, await approveMcpClient(app, MCP_TEST_VIEWER))
    ).json()) as McpTokenBody;

    const response = await listTools(app, personal.token);
    const removedDomain = await listTools(
      await createApp({ allowedDomains: ["other.example"] }),
      tokens.access_token,
    );

    expect(removedDomain.status).toBe(401);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer error="invalid_token", resource_metadata="${MCP_TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp", scope="${ALL_SCOPES}"`,
    );
  });

  it("ends a grant 30 days after consent even when it is refreshed", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const day = 24 * 60 * 60 * 1000;
    const startMs = Date.now();
    const tokens = (await (
      await exchangeMcpCode(app, await approveMcpClient(app, MCP_TEST_VIEWER))
    ).json()) as McpTokenBody;

    vi.useFakeTimers({ now: startMs + 29 * day, toFake: ["Date"] });
    const refreshed = (await (
      await refresh(app, tokens.refresh_token)
    ).json()) as McpTokenBody;
    vi.setSystemTime(startMs + 31 * day);
    const afterEnd = await refresh(app, refreshed.refresh_token);

    expect(refreshed.refresh_token).toMatch(/^jr_mcp_rt_/);
    expect(afterEnd.status).toBe(400);
    await expect(afterEnd.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
  });

  it("revokes the grant when a code or a rotated refresh token is reused", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    const approval = await approveMcpClient(app, MCP_TEST_VIEWER);
    const first = (await (
      await exchangeMcpCode(app, approval)
    ).json()) as McpTokenBody;
    const reusedCode = await exchangeMcpCode(app, approval);
    const afterCodeReuse = await refresh(app, first.refresh_token);

    const second = (await (
      await exchangeMcpCode(app, await approveMcpClient(app, MCP_TEST_VIEWER))
    ).json()) as McpTokenBody;
    const rotatedOnce = (await (
      await refresh(app, second.refresh_token)
    ).json()) as McpTokenBody;
    // A concurrent refresh by another client process loses without logout.
    const racedRefresh = await refresh(app, second.refresh_token);
    const rotated = (await (
      await refresh(app, rotatedOnce.refresh_token)
    ).json()) as McpTokenBody;
    vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
    const reusedRefresh = await refresh(app, rotatedOnce.refresh_token);
    const afterRefreshReuse = await refresh(app, rotated.refresh_token);
    const revokedAccess = await listTools(app, rotated.access_token);

    expect(reusedCode.status).toBe(400);
    await expect(reusedCode.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(afterCodeReuse.status).toBe(400);
    expect(racedRefresh.status).toBe(400);
    expect(rotated.access_token).toMatch(/^jr_mcp_at_/);
    expect(reusedRefresh.status).toBe(400);
    await expect(reusedRefresh.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(afterRefreshReuse.status).toBe(400);
    expect(revokedAccess.status).toBe(401);
  });

  it.each([
    [
      "a private IP client ID",
      "https://10.0.0.5/client.json",
      MCP_TEST_REDIRECT_URI,
    ],
    [
      "a document for another client ID",
      MCP_MISMATCHED_CLIENT_ID,
      MCP_TEST_REDIRECT_URI,
    ],
    ["an unregistered redirect URI", MCP_CLIENT_ID, "https://evil.example/cb"],
  ])(
    "shows an error without redirecting for %s",
    async (_, clientId, redirectUri) => {
      const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });

      const response = await app.request(
        mcpAuthorizeUrl({
          client_id: clientId,
          code_challenge: createPkce().challenge,
          redirect_uri: redirectUri,
        }),
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      await expect(response.text()).resolves.toContain(
        "This app cannot connect",
      );
    },
  );

  it("shows the requested scopes and lists only their tools", async () => {
    const app = await createApp({ allowedDomains: MCP_TEST_ALLOWED_DOMAINS });
    // An empty scope asks for every scope.
    const everyScope = await approveMcpClient(app, MCP_TEST_VIEWER, "");
    const everyTokens = (await (
      await exchangeMcpCode(app, everyScope)
    ).json()) as McpTokenBody;
    const readOnly = await connectMcpClient(
      app,
      MCP_TEST_VIEWER,
      "conversations:read",
    );
    const toolNames = async (token: string) =>
      (await withMcpClient(app, token, (client) => client.listTools())).tools
        .map((tool) => tool.name)
        .sort();
    const invalidScope = await app.request(
      mcpAuthorizeUrl({
        client_id: MCP_CLIENT_ID,
        code_challenge: createPkce().challenge,
        redirect_uri: MCP_TEST_REDIRECT_URI,
        scope: "conversations:delete",
      }),
    );
    const widenedRefresh = await requestMcpTokens(app, {
      client_id: MCP_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: everyTokens.refresh_token,
      resource: MCP_TEST_URL,
      scope: "conversations:read",
    });

    for (const scope of ALL_SCOPES.split(" ")) {
      expect(everyScope.consentHtml).toContain(scope);
    }
    expect(everyTokens.scope).toBe(ALL_SCOPES);
    expect(await toolNames(everyTokens.access_token)).toEqual([
      "archiveConversation",
      "archiveDoneConversations",
      "cancelQueuedMessages",
      "createConversation",
      "getAutomation",
      "getConversation",
      "getReviewItem",
      "listConversationMessages",
      "markConversationRead",
      "pinConversation",
      "searchAutomations",
      "searchConversations",
      "searchReviewItems",
      "sendMessage",
      "setConversationAutoArchive",
      "stopConversation",
    ]);
    expect(await toolNames(readOnly)).toEqual([
      "getConversation",
      "listConversationMessages",
      "searchConversations",
    ]);
    expect(
      new URL(invalidScope.headers.get("location") ?? "").searchParams.get(
        "error",
      ),
    ).toBe("invalid_scope");
    await expect(widenedRefresh.json()).resolves.toMatchObject({
      error: "invalid_scope",
    });
  });

  it("does not mount when dashboard sign-in is not required", async () => {
    const app = await createApp({
      dashboard: { authRequired: false, baseURL: MCP_TEST_ORIGIN },
    });

    const response = await app.request(MCP_TEST_URL, { method: "POST" });
    const metadata = await app.request(
      `${MCP_TEST_ORIGIN}/.well-known/oauth-authorization-server`,
    );
    const consent = await app.request(
      `${MCP_TEST_ORIGIN}/_junior/mcp/authorize/${"a".repeat(43)}`,
    );

    expect(response.status).toBe(404);
    expect(metadata.status).toBe(404);
    expect(consent.status).toBe(404);
  });
});
