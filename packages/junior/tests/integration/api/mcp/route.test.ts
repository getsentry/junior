import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import {
  MCP_TEST_ORIGIN,
  MCP_TEST_URL,
  authorizeUrl,
  createPkce,
  mockMcpDashboardConfig,
  openConsentPage,
  requestTokens,
  submitConsent,
} from "../../../fixtures/mcp-http";
import {
  MCP_CLIENT_ID,
  MCP_CLIENT_NAME,
  MCP_MISMATCHED_CLIENT_ID,
} from "../../../msw/handlers/mcp-client-metadata";

const VIEWER = "mcp-viewer@example.com";
const OTHER_VIEWER = "mcp-other@example.com";
// Claude Code listens on a random loopback port.
const REDIRECT_URI = "http://127.0.0.1:53682/callback";

type TokenBody = {
  access_token: string;
  error?: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
  token_type: string;
};

mockMcpDashboardConfig();

/** Approve the test client as one viewer and return its code and verifier. */
async function approveClient(
  app: Hono,
  email: string,
): Promise<{ code: string; verifier: string }> {
  const pkce = createPkce();
  const authorize = await app.request(
    authorizeUrl({
      client_id: MCP_CLIENT_ID,
      code_challenge: pkce.challenge,
      redirect_uri: REDIRECT_URI,
    }),
  );
  const consentUrl = authorize.headers.get("location") ?? "";
  const page = await openConsentPage(app, consentUrl, email);
  const approved = await submitConsent({
    action: "approve",
    app,
    consentUrl,
    csrf: page.csrf ?? "",
    email,
  });
  const code = new URL(approved.headers.get("location") ?? "").searchParams.get(
    "code",
  );
  if (!code) throw new Error("MCP consent returned no code");
  return { code, verifier: pkce.verifier };
}

function exchangeCode(
  app: Hono,
  args: { code: string; verifier: string },
): Promise<Response> {
  return requestTokens(app, {
    client_id: MCP_CLIENT_ID,
    code: args.code,
    code_verifier: args.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    resource: MCP_TEST_URL,
  });
}

function refresh(app: Hono, refreshToken: string): Promise<Response> {
  return requestTokens(app, {
    client_id: MCP_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource: MCP_TEST_URL,
  });
}

describe("remote MCP HTTP", () => {
  it("connects a CIMD client through discovery, consent, and token rotation", async () => {
    const app = await createApp();
    const pkce = createPkce();

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
        authorizeUrl({
          client_id: MCP_CLIENT_ID,
          code_challenge: pkce.challenge,
          redirect_uri: REDIRECT_URI,
          state: "client-state",
        }),
      ).searchParams.toString()}`,
    );
    const consentUrl = authorize.headers.get("location") ?? "";
    const page = await openConsentPage(app, consentUrl, VIEWER);
    const otherPage = await openConsentPage(app, consentUrl, OTHER_VIEWER);
    const approved = await submitConsent({
      action: "approve",
      app,
      consentUrl,
      csrf: page.csrf ?? "",
      email: VIEWER,
    });
    const callback = new URL(approved.headers.get("location") ?? "");
    const issued = await exchangeCode(app, {
      code: callback.searchParams.get("code") ?? "",
      verifier: pkce.verifier,
    });
    const tokens = (await issued.json()) as TokenBody;
    const rotated = await refresh(app, tokens.refresh_token);
    const rotatedTokens = (await rotated.json()) as TokenBody;

    expect(challenge.status).toBe(401);
    expect(resourceMetadata).toEqual({
      resource: MCP_TEST_URL,
      authorization_servers: [MCP_TEST_ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: ["conversations:read"],
    });
    expect(serverMetadata).toEqual({
      issuer: MCP_TEST_ORIGIN,
      authorization_endpoint: `${MCP_TEST_ORIGIN}/api/mcp/oauth/authorize`,
      token_endpoint: `${MCP_TEST_ORIGIN}/api/mcp/oauth/token`,
      scopes_supported: ["conversations:read"],
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
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
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
    expect(rotated.status).toBe(200);
    expect(rotatedTokens.refresh_token).not.toBe(tokens.refresh_token);
  });

  it("revokes the grant when a code or a rotated refresh token is reused", async () => {
    const app = await createApp();
    const approval = await approveClient(app, VIEWER);
    const first = (await (
      await exchangeCode(app, approval)
    ).json()) as TokenBody;
    const reusedCode = await exchangeCode(app, approval);
    const afterCodeReuse = await refresh(app, first.refresh_token);

    const second = (await (
      await exchangeCode(app, await approveClient(app, VIEWER))
    ).json()) as TokenBody;
    const rotated = (await (
      await refresh(app, second.refresh_token)
    ).json()) as TokenBody;
    const reusedRefresh = await refresh(app, second.refresh_token);
    const afterRefreshReuse = await refresh(app, rotated.refresh_token);

    expect(reusedCode.status).toBe(400);
    await expect(reusedCode.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(afterCodeReuse.status).toBe(400);
    expect(reusedRefresh.status).toBe(400);
    await expect(reusedRefresh.json()).resolves.toMatchObject({
      error: "invalid_grant",
    });
    expect(afterRefreshReuse.status).toBe(400);
  });

  it.each([
    ["a client ID that is not a URL", "claude-code", REDIRECT_URI],
    ["a private IP client ID", "https://10.0.0.5/client.json", REDIRECT_URI],
    [
      "a document for another client ID",
      MCP_MISMATCHED_CLIENT_ID,
      REDIRECT_URI,
    ],
    ["an unregistered redirect URI", MCP_CLIENT_ID, "https://evil.example/cb"],
  ])(
    "shows an error without redirecting for %s",
    async (_, clientId, redirectUri) => {
      const app = await createApp();

      const response = await app.request(
        authorizeUrl({
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

  it("does not mount without dashboard sign-in", async () => {
    const app = await createApp({ dashboard: { disabled: true } });

    const response = await app.request(MCP_TEST_URL, { method: "POST" });
    const metadata = await app.request(
      `${MCP_TEST_ORIGIN}/.well-known/oauth-authorization-server`,
    );

    expect(response.status).toBe(404);
    expect(metadata.status).toBe(404);
  });
});
