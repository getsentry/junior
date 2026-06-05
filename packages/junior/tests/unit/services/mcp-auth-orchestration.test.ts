import { describe, expect, it, vi } from "vitest";
import type { McpAuthSessionState } from "@/chat/mcp/auth-store";
import type { PluginDefinition } from "@/chat/plugins/types";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import type { PluginDefinition } from "@/chat/plugins/types";

type McpAuthServices = NonNullable<
  Parameters<typeof createMcpAuthOrchestration>[2]
>;
type McpAuthProvider = Awaited<
  ReturnType<McpAuthServices["createMcpOAuthClientProvider"]>
>;

const githubMcpPlugin: PluginDefinition = {
  dir: "/tmp/github-plugin",
  manifest: {
    name: "github",
    description: "GitHub MCP provider",
    capabilities: [],
    configKeys: [],
    mcp: {
      transport: "http",
      url: "https://mcp.github.example.test",
    },
  },
};

const authSession: McpAuthSessionState = {
  authSessionId: "auth_1",
  provider: "github",
  userId: "U123",
  conversationId: "slack:C123:1700000000.000000",
  sessionId: "scheduled:sched_1:1000",
  userMessage: "<scheduled-task-run />",
  channelId: "C123",
  threadTs: "1700000000.000000",
  authorizationUrl: "https://github.example.test/oauth/authorize",
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_000_000,
};

function createMcpAuthProvider(authSessionId: string): McpAuthProvider {
  return {
    authSessionId,
    redirectUrl: "https://junior.example.test/api/oauth/callback/mcp/github",
    clientMetadata: {
      client_name: "Junior MCP Client",
      redirect_uris: [
        "https://junior.example.test/api/oauth/callback/mcp/github",
      ],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    state: vi.fn(async () => authSessionId),
    clientInformation: vi.fn(async () => undefined),
    saveClientInformation: vi.fn(async () => undefined),
    tokens: vi.fn(async () => undefined),
    saveTokens: vi.fn(async () => undefined),
    redirectToAuthorization: vi.fn(async () => undefined),
    saveCodeVerifier: vi.fn(async () => undefined),
    codeVerifier: vi.fn(async () => "code-verifier"),
  } satisfies McpAuthProvider;
}

function createMcpAuthServices() {
  return {
    createMcpOAuthClientProvider: vi.fn(async () =>
      createMcpAuthProvider("auth_1"),
    ),
    deleteMcpAuthSession: vi.fn(async () => undefined),
    deliverPrivateMessage: vi.fn(async () => "fallback_dm" as const),
    formatProviderLabel: vi.fn((provider: string) => provider),
    getMcpAuthSession: vi.fn(async () => authSession),
    now: vi.fn(() => 1_700_000_000_000),
    patchMcpAuthSession: vi.fn(async (_authSessionId, patch) => ({
      ...authSession,
      ...patch,
      authSessionId: authSession.authSessionId,
      provider: authSession.provider,
      userId: authSession.userId,
      conversationId: authSession.conversationId,
      sessionId: authSession.sessionId,
      userMessage: authSession.userMessage,
      createdAtMs: authSession.createdAtMs,
      updatedAtMs: 1_700_000_000_001,
    })),
    recordAuthorizationRequested: vi.fn(async () => undefined),
  } satisfies McpAuthServices;
}

function plugin(name: string): PluginDefinition {
  return {
    dir: `/plugins/${name}`,
    manifest: {
      name,
      displayName: name,
      description: `${name} plugin`,
      capabilities: [],
      configKeys: [],
    },
  };
}

describe("createMcpAuthOrchestration", () => {
  it("returns a deterministic error instead of delivering auth links when authorization is disabled", async () => {
    const services = createMcpAuthServices();
    const abortAgent = vi.fn();
    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      services,
    );

    await orchestration.authProviderFactory(githubMcpPlugin);

    await expect(
      orchestration.onAuthorizationRequired("github"),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(services.deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(services.patchMcpAuthSession).not.toHaveBeenCalled();
    expect(services.getMcpAuthSession).not.toHaveBeenCalled();
    expect(services.deliverPrivateMessage).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("fails before preparing and delivering an auth link when pending auth cannot be recorded", async () => {
    const abortAgent = vi.fn();
    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      requesterId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userMessage: "use MCP",
      getConfiguration: () => ({}),
      getArtifactState: () => undefined,
      getMergedArtifactState: () => ({}),
    });

    await expect(
      orchestration.authProviderFactory(plugin("github")),
    ).rejects.toThrow(
      'Missing pending auth recorder for MCP authorization pause "github"',
    );

    expect(createMcpOAuthClientProvider).not.toHaveBeenCalled();
    expect(patchMcpAuthSession).not.toHaveBeenCalled();
    expect(getMcpAuthSession).not.toHaveBeenCalled();
    expect(deliverPrivateMessage).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("sends a fresh link when the pending auth belongs to a previous session", async () => {
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn();
    getMcpAuthSession.mockResolvedValue({
      authorizationUrl: "https://mcp.example/authorize",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userId: "U123",
    });
    deliverPrivateMessage.mockResolvedValue({ channelId: "D123" });

    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      requesterId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userMessage: "use MCP",
      pendingAuth: {
        kind: "mcp",
        provider: "github",
        requesterId: "U123",
        sessionId: "run_old",
        linkSentAtMs: Date.now(),
      },
      getConfiguration: () => ({}),
      getArtifactState: () => undefined,
      getMergedArtifactState: () => ({}),
      recordPendingAuth,
    });

    await orchestration.authProviderFactory(plugin("github"));

    await expect(orchestration.onAuthorizationRequired("github")).resolves.toBe(
      true,
    );

    expect(deliverPrivateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U123",
      }),
    );
    expect(deleteMcpAuthSession).not.toHaveBeenCalled();
    expect(recordPendingAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mcp",
        provider: "github",
        requesterId: "U123",
        sessionId: "run_new",
      }),
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });
});
