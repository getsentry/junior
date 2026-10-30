import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import {
  MCP_TEST_ORIGIN,
  MCP_TEST_URL,
  authorizeUrl,
  createPkce,
  mockMcpDashboardConfig,
  openConsentPage,
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

mockMcpDashboardConfig();

describe("remote MCP HTTP", () => {
  it("advertises CIMD OAuth discovery from the unauthenticated challenge", async () => {
    const app = await createApp();

    const challenge = await app.request(MCP_TEST_URL, { method: "POST" });
    const resourceMetadataURL = challenge.headers
      .get("www-authenticate")
      ?.match(/resource_metadata="([^"]+)"/)?.[1];
    const resource = await app.request(resourceMetadataURL ?? "");
    const resourceMetadata = (await resource.json()) as {
      authorization_servers: string[];
    };
    const issuer = resourceMetadata.authorization_servers[0];
    const server = await app.request(
      `${issuer}/.well-known/oauth-authorization-server`,
    );

    expect(challenge.status).toBe(401);
    expect(resourceMetadataURL).toBe(
      `${MCP_TEST_ORIGIN}/.well-known/oauth-protected-resource/api/mcp`,
    );
    expect(resourceMetadata).toEqual({
      resource: MCP_TEST_URL,
      authorization_servers: [MCP_TEST_ORIGIN],
      bearer_methods_supported: ["header"],
      scopes_supported: ["conversations:read"],
    });
    await expect(server.json()).resolves.toEqual({
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
  });

  it("issues a code after the signed-in user approves", async () => {
    const app = await createApp();
    const pkce = createPkce();

    const authorize = await app.request(
      authorizeUrl({
        client_id: MCP_CLIENT_ID,
        code_challenge: pkce.challenge,
        redirect_uri: REDIRECT_URI,
        state: "client-state",
      }),
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
    const replay = await submitConsent({
      action: "approve",
      app,
      consentUrl,
      csrf: page.csrf ?? "",
      email: VIEWER,
    });

    expect(authorize.status).toBe(302);
    expect(consentUrl).toMatch(
      new RegExp(`^${MCP_TEST_ORIGIN}/_junior/mcp/authorize/[\\w-]{43}$`),
    );
    expect(page.status).toBe(200);
    expect(page.html).toContain(`Connect ${MCP_CLIENT_NAME}`);
    expect(page.html).toContain("mcp-client.example.test");
    expect(otherPage.status).toBe(403);
    expect(approved.status).toBe(303);
    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("code")).toMatch(/^[\w-]{43}$/);
    expect(callback.searchParams.get("state")).toBe("client-state");
    expect(callback.searchParams.get("iss")).toBe(MCP_TEST_ORIGIN);
    expect(replay.status).toBe(410);
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
