import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_ACCOUNT_MCP_CODE,
  SERVICE_ACCOUNT_MCP_URL,
  useServiceAccountMcpServer,
} from "../../fixtures/service-account-mcp";
import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import { McpServiceAccountRequiredError } from "@/chat/mcp/errors";
import {
  deleteMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import {
  createMcpServiceAccountClientProvider,
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
    accounts: { serviceAccount: { tools: ["search"] } },
  },
};

/** The same plugin, but Actors cannot use their own connection. */
const onlyPlugin: PluginDefinition = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    accounts: { userOAuth: false, serviceAccount: { tools: ["search"] } },
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

function createManager(
  onAuthorizationRequired = vi.fn(),
  managedPlugin = plugin,
  authProviderFactory = unconnectedActorAuth,
) {
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
    manager: new McpToolManager([managedPlugin], {
      authProviderFactory,
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
    const onAuthorizationRequired = vi.fn(async () => false);

    // A declared service account that no admin connected yet changes nothing.
    const unconnected = createManager(onAuthorizationRequired);
    try {
      await expect(
        unconnected.mcpAuth.serviceAccountProviderFactory(plugin),
      ).resolves.toBeUndefined();
      await expect(
        unconnected.manager.activateProvider(PROVIDER),
      ).rejects.toBeInstanceOf(McpAuthorizationRequiredError);
      expect(onAuthorizationRequired).toHaveBeenCalledWith(
        PROVIDER,
        expect.any(McpAuthorizationRequiredError),
        undefined,
      );
    } finally {
      await unconnected.manager.close();
    }
    onAuthorizationRequired.mockClear();

    await connectServiceAccount();
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

  it("uses only the service account when the plugin allows no actor connections", async () => {
    useServiceAccountMcpServer();
    const onAuthorizationRequired = vi.fn(async () => false);
    const actorAuth = vi.fn(unconnectedActorAuth);
    await putMcpStoredOAuthCredentials(ACTOR_ID, PROVIDER, {
      tokens: { access_token: "actor-token", token_type: "Bearer" },
    });

    const unconnected = createManager(
      onAuthorizationRequired,
      onlyPlugin,
      actorAuth,
    ).manager;
    try {
      await expect(
        unconnected.activateProvider(PROVIDER),
      ).rejects.toBeInstanceOf(McpServiceAccountRequiredError);
    } finally {
      await unconnected.close();
    }

    await connectServiceAccount();
    const connected = createManager(
      onAuthorizationRequired,
      onlyPlugin,
      actorAuth,
    ).manager;
    try {
      await connected.activateProvider(PROVIDER);
      // No actor connection exists to call the unlisted tool, so it is hidden.
      expect(
        connected.getResolvedActiveTools().map((managed) => managed.rawName),
      ).toEqual(["search"]);
      await expect(
        tool(connected, "search").execute({}),
      ).resolves.toMatchObject({
        content: [{ type: "text", text: "access-1" }],
      });
    } finally {
      await connected.close();
    }
    expect(actorAuth).not.toHaveBeenCalled();
    expect(onAuthorizationRequired).not.toHaveBeenCalled();
  });

  it("refreshes the shared token and falls back to the actor once the provider revokes the grant", async () => {
    const server = useServiceAccountMcpServer();
    await connectServiceAccount();

    // A token endpoint outage fails the request but keeps the account.
    server.expireAccessTokens();
    server.setTokenEndpointDown(true);
    const outage = createManager().manager;
    try {
      const failure = await outage
        .activateProvider(PROVIDER)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(McpAuthorizationRequiredError);
    } finally {
      await outage.close();
    }
    expect(
      (await getMcpServiceAccountCredentials(PROVIDER))?.tokens.refresh_token,
    ).toBe("refresh-1");
    server.setTokenEndpointDown(false);

    // A turn that read a refresh token that another turn already replaced
    // retries with the stored token instead of dropping the account.
    const stale = createMcpServiceAccountClientProvider(
      PROVIDER,
      (await getMcpServiceAccountCredentials(PROVIDER))!,
    );
    await expect(stale.tokens()).resolves.toMatchObject({
      refresh_token: "refresh-1",
    });
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
    await stale.invalidateCredentials?.("tokens");
    await expect(stale.tokens()).resolves.toMatchObject({
      refresh_token: "refresh-2",
    });

    // Per-user OAuth is on, so a revoked account sends the actor to connect.
    server.revokeGrant();
    const onAuthorizationRequired = vi.fn(async () => false);
    const revoked = createManager(onAuthorizationRequired).manager;
    try {
      await expect(revoked.activateProvider(PROVIDER)).rejects.toBeInstanceOf(
        McpAuthorizationRequiredError,
      );
    } finally {
      await revoked.close();
    }
    expect(onAuthorizationRequired).toHaveBeenCalledWith(
      PROVIDER,
      expect.any(McpAuthorizationRequiredError),
      undefined,
    );
    await expect(
      getMcpServiceAccountCredentials(PROVIDER),
    ).resolves.toBeUndefined();
  });

  it("reports the missing account when a service-account-only grant is revoked", async () => {
    const server = useServiceAccountMcpServer();
    await connectServiceAccount();
    server.revokeGrant();
    const onAuthorizationRequired = vi.fn(async () => false);
    const { manager } = createManager(onAuthorizationRequired, onlyPlugin);
    try {
      await expect(manager.activateProvider(PROVIDER)).rejects.toBeInstanceOf(
        McpServiceAccountRequiredError,
      );
    } finally {
      await manager.close();
    }
    expect(onAuthorizationRequired).not.toHaveBeenCalled();
    await expect(
      getMcpServiceAccountCredentials(PROVIDER),
    ).resolves.toBeUndefined();
  });
});
