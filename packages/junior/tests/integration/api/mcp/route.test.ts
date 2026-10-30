import { describe, expect, it } from "vitest";
import { createApp } from "@/app";
import {
  MCP_TEST_ORIGIN,
  MCP_TEST_URL,
  mockMcpDashboardConfig,
} from "../../../fixtures/mcp-http";

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
