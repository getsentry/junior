import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { decodeProtectedHeader, jwtVerify } from "jose";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mcpHandshakeResponse,
  type McpJsonRpcMessage,
} from "../../msw/handlers/mcp-handshake";
import { mswServer } from "../../msw/server";
import {
  McpAuthorizationRequiredError,
  PluginMcpClient,
} from "@/chat/mcp/client";
import { McpProviderError } from "@/chat/mcp/errors";
import { createJwtBearerMcpClientProvider } from "@/chat/mcp/jwt-bearer-provider";
import type { PluginDefinition } from "@/chat/plugins/types";

const ORIGIN = "https://bot-mcp.example.test";
const MCP_URL = `${ORIGIN}/mcp`;
const PROVIDER = "bot-mcp";
const CLIENT_ID = "bot-client";
const ACCESS_TOKEN = "bot-access-token";
const AUTH = {
  issuer: "https://junior.example.test",
  keyId: "junior-1",
  privateKeyEnv: "TEST_BOT_MCP_PRIVATE_KEY",
};

// Key generation is slow, and no test mutates these.
const TRUSTED_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });
const UNTRUSTED_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwtBearerClient(): PluginMcpClient {
  const plugin: PluginDefinition = {
    dir: `/plugins/${PROVIDER}`,
    manifest: {
      name: PROVIDER,
      displayName: "Bot MCP",
      description: "MCP server that trusts Junior as a bot",
      configKeys: [],
      mcp: { transport: "http", url: MCP_URL, auth: AUTH },
    },
  };
  return new PluginMcpClient(plugin, {
    authProvider: createJwtBearerMcpClientProvider(PROVIDER, MCP_URL, AUTH),
  });
}

/**
 * Serve a jwt-bearer MCP server that only trusts assertions signed by `trustedKey`.
 * The token endpoint makes the same assertion checks as an RFC 7523 identity-assertion server.
 */
function useJwtBearerMcpServer(trustedKey: KeyObject) {
  const tokenRequests: URLSearchParams[] = [];
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
      }),
    ),
    http.get(`${ORIGIN}/.well-known/oauth-authorization-server`, () =>
      HttpResponse.json({
        issuer: `${ORIGIN}/`,
        authorization_endpoint: `${ORIGIN}/authorize`,
        token_endpoint: `${ORIGIN}/token`,
        registration_endpoint: `${ORIGIN}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
        token_endpoint_auth_methods_supported: ["none"],
      }),
    ),
    http.post(`${ORIGIN}/register`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ ...body, client_id: CLIENT_ID });
    }),
    http.post(`${ORIGIN}/token`, async ({ request }) => {
      const params = new URLSearchParams(await request.text());
      tokenRequests.push(params);
      try {
        const assertion = params.get("assertion") ?? "";
        if (decodeProtectedHeader(assertion).kid !== AUTH.keyId) {
          throw new Error("unknown key id");
        }
        const { payload } = await jwtVerify(assertion, trustedKey, {
          issuer: AUTH.issuer,
          audience: `${ORIGIN}/`,
          subject: PROVIDER,
          typ: "oauth-id-jag+jwt",
        });
        if (payload.client_id !== CLIENT_ID || payload.resource !== MCP_URL) {
          throw new Error("assertion does not match client and resource");
        }
      } catch {
        return HttpResponse.json(
          { error: "invalid_grant", error_description: "bad assertion" },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: ACCESS_TOKEN,
        token_type: "Bearer",
        expires_in: 300,
      });
    }),
  );
  return { tokenRequests };
}

describe("jwt-bearer MCP auth through PluginMcpClient", () => {
  beforeEach(() => {
    process.env[AUTH.privateKeyEnv] = TRUSTED_KEY.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
  });

  afterEach(() => {
    delete process.env[AUTH.privateKeyEnv];
  });

  it("exchanges a signed assertion for an access token without user interaction", async () => {
    const server = useJwtBearerMcpServer(TRUSTED_KEY.publicKey);
    const client = jwtBearerClient();

    try {
      const tools = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(["status"]);
      expect(server.tokenRequests).toHaveLength(1);
      expect(server.tokenRequests[0]?.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
    } finally {
      await client.close();
    }
  });

  it("surfaces a rejected assertion as a provider failure, not an authorization pause", async () => {
    const server = useJwtBearerMcpServer(UNTRUSTED_KEY.publicKey);
    const client = jwtBearerClient();

    try {
      const failure = await client.listTools().catch((error: unknown) => error);

      expect(server.tokenRequests.length).toBeGreaterThan(0);
      expect(failure).not.toBeInstanceOf(McpAuthorizationRequiredError);
      expect(failure).toBeInstanceOf(McpProviderError);
    } finally {
      await client.close();
    }
  });
});
