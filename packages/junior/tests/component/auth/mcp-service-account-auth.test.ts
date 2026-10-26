import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_ACCOUNT_MCP_CODE,
  SERVICE_ACCOUNT_MCP_URL,
  useServiceAccountMcpServer,
} from "../../fixtures/service-account-mcp";
import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import {
  deleteMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import {
  deleteMcpServiceAccountCredentials,
  finishMcpServiceAccountSignIn,
  getMcpServiceAccountCredentials,
  startMcpServiceAccountSignIn,
} from "@/chat/mcp/service-account";
import { McpToolManager } from "@/chat/mcp/tool-manager";
import type { PluginDefinition } from "@/chat/plugins/types";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";

const PROVIDER = "docs-mcp";
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
      url: SERVICE_ACCOUNT_MCP_URL,
      allowedTools: ["search", "create"],
    },
    serviceAccount: { mcpTools: ["search"] },
  },
};

async function connectServiceAccount(): Promise<void> {
  const { authorizationUrl } = await startMcpServiceAccountSignIn({
    plugin,
    redirectUrl: "http://127.0.0.1:8765/oauth/callback",
  });
  const result = await finishMcpServiceAccountSignIn({
    callback: new URLSearchParams({
      code: SERVICE_ACCOUNT_MCP_CODE,
      state: authorizationUrl.searchParams.get("state") ?? "",
    }),
    plugin,
  });
  expect(result.ok).toBe(true);
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
