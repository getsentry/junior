import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_ACCOUNT_MCP_CODE,
  SERVICE_ACCOUNT_MCP_URL,
  useServiceAccountMcpServer,
} from "../../fixtures/service-account-mcp";
import { type EmittedLogRecord, registerLogRecordSink } from "@/chat/logging";
import { McpAuthorizationRequiredError } from "@/chat/mcp/client";
import { McpServiceAccountRequiredError } from "@/chat/mcp/errors";
import {
  deleteMcpStoredOAuthCredentials,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import {
  disconnectServiceAccount,
  getServiceAccountStatus,
} from "@/chat/credentials/service-account";
import {
  createMcpServiceAccountClientProvider,
  finishMcpServiceAccountSignIn,
  getMcpServiceAccount,
  type McpServiceAccountCredentials,
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

/** Start a sign-in and return its approved provider callback. */
async function approvedSignIn(): Promise<URLSearchParams> {
  const { authorizationUrl } = await startMcpServiceAccountSignIn({
    plugin,
    redirectUrl: "http://127.0.0.1:8765/oauth/callback",
  });
  return new URLSearchParams({
    code: SERVICE_ACCOUNT_MCP_CODE,
    state: authorizationUrl.searchParams.get("state") ?? "",
  });
}

async function connectServiceAccount(): Promise<void> {
  const result = await finishMcpServiceAccountSignIn({
    callback: await approvedSignIn(),
    plugin,
  });
  expect(result.ok).toBe(true);
}

async function connectedAccount(): Promise<McpServiceAccountCredentials> {
  const account = await getMcpServiceAccount(PROVIDER);
  if (account?.status !== "connected") {
    throw new Error("service account is not connected");
  }
  return account;
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
    await disconnectServiceAccount(plugin);
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
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => {
      records.push(record);
    });

    try {
      await manager.activateProvider(PROVIDER);
      await expect(tool(manager, "search").execute({})).resolves.toMatchObject({
        content: [{ type: "text", text: "access-1" }],
      });
      expect(
        records.find((record) => record.eventName === "mcp.tool_call.completed")
          ?.attributes,
      ).toMatchObject({
        "app.credential.account": "service_account",
        "app.log.audit": true,
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
      unregister();
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
    await expect(getMcpServiceAccount(PROVIDER)).resolves.toMatchObject({
      status: "connected",
      tokens: { refresh_token: "refresh-1" },
    });
    server.setTokenEndpointDown(false);

    // A turn that read a refresh token that another turn already replaced
    // retries with the stored token instead of dropping the account.
    const stale = createMcpServiceAccountClientProvider(
      PROVIDER,
      await connectedAccount(),
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
    const staleRedirect = await Promise.resolve(
      stale.redirectToAuthorization(new URL(`${SERVICE_ACCOUNT_MCP_URL}/x`)),
    ).catch((error: unknown) => error);
    expect(staleRedirect).toBeInstanceOf(Error);
    expect(staleRedirect).not.toBeInstanceOf(McpAuthorizationRequiredError);
    await expect(getMcpServiceAccount(PROVIDER)).resolves.toMatchObject({
      status: "connected",
      tokens: { refresh_token: "refresh-2" },
    });
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
    // Admins see that the provider revoked the account, not that nobody
    // connected it. A Disconnect clears the revocation.
    await expect(getServiceAccountStatus(plugin)).resolves.toMatchObject({
      status: "revoked",
      connected: false,
      revokedAt: expect.any(String),
    });
    await disconnectServiceAccount(plugin);
    await expect(getServiceAccountStatus(plugin)).resolves.toMatchObject({
      status: "disconnected",
    });
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
    await expect(getMcpServiceAccount(PROVIDER)).resolves.toMatchObject({
      status: "revoked",
    });
  });

  it("keeps a Disconnect and a single-use new sign-in when an older turn saves tokens late", async () => {
    useServiceAccountMcpServer();
    const lateTokens = {
      access_token: "late-access",
      refresh_token: "late-refresh",
      token_type: "Bearer",
    };
    await connectServiceAccount();
    const late = createMcpServiceAccountClientProvider(
      PROVIDER,
      await connectedAccount(),
    );

    await disconnectServiceAccount(plugin);
    await expect(late.saveTokens(lateTokens)).rejects.toThrow(
      "changed during this request",
    );
    await expect(getMcpServiceAccount(PROVIDER)).resolves.toBeUndefined();

    // A repeated callback finishes the sign-in only once.
    const callback = await approvedSignIn();
    const finished = await Promise.all([
      finishMcpServiceAccountSignIn({ callback, plugin }),
      finishMcpServiceAccountSignIn({ callback, plugin }),
    ]);
    expect(finished.filter((result) => result.ok)).toHaveLength(1);
    const current = await connectedAccount();
    await expect(late.saveTokens(lateTokens)).rejects.toThrow(
      "changed during this request",
    );
    await expect(late.tokens()).resolves.toBeUndefined();
    await expect(getMcpServiceAccount(PROVIDER)).resolves.toEqual(current);
  });
});
