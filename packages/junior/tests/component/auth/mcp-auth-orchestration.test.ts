import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpAuthSessionState } from "@/chat/mcp/auth-store";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import type { PluginDefinition } from "@/chat/plugins/types";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import { mockTestClock } from "../../fixtures/vitest";

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
    displayName: "GitHub",
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
    getMcpAuthSession: vi.fn(async () => authSession),
    patchMcpAuthSession: vi.fn(async (_authSessionId, patch) => ({
      ...authSession,
      ...patch,
      updatedAtMs: 1_700_000_000_001,
    })),
    recordAuthorizationRequested: vi.fn(async () => undefined),
  } satisfies McpAuthServices;
}

function baseInput(
  overrides: {
    pendingAuth?: Parameters<
      typeof createMcpAuthOrchestration
    >[0]["pendingAuth"];
    recordPendingAuth?: Parameters<
      typeof createMcpAuthOrchestration
    >[0]["recordPendingAuth"];
    authorizationFlowMode?: Parameters<
      typeof createMcpAuthOrchestration
    >[0]["authorizationFlowMode"];
  } = {},
): Parameters<typeof createMcpAuthOrchestration>[0] {
  return {
    conversationId: "slack:C123:1700000000.000000",
    sessionId: "scheduled:sched_1:1000",
    requesterId: "U123",
    channelId: "C123",
    threadTs: "1700000000.000000",
    userMessage: "<scheduled-task-run />",
    pendingAuth: overrides.pendingAuth,
    getConfiguration: () => ({ repo: "getsentry/junior" }),
    getArtifactState: () => undefined,
    getMergedArtifactState: () => ({
      assistantContextChannelId: "C456",
    }),
    recordPendingAuth: overrides.recordPendingAuth ?? vi.fn(),
    authorizationFlowMode: overrides.authorizationFlowMode,
  };
}

describe("createMcpAuthOrchestration", () => {
  beforeEach(() => {
    mockTestClock(1_700_000_000_000);
    setPluginCatalogConfig({
      inlineManifests: [{ manifest: githubMcpPlugin.manifest }],
    });
  });

  afterEach(() => {
    setPluginCatalogConfig(undefined);
    vi.useRealTimers();
  });

  it("sends a private auth link and records the paused session", async () => {
    const services = createMcpAuthServices();
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn(async () => undefined);
    const orchestration = createMcpAuthOrchestration(
      baseInput({ recordPendingAuth }),
      abortAgent,
      services,
    );

    await orchestration.authProviderFactory(githubMcpPlugin);
    await expect(orchestration.onAuthorizationRequired("github")).resolves.toBe(
      true,
    );

    expect(services.patchMcpAuthSession).toHaveBeenCalledWith("auth_1", {
      configuration: { repo: "getsentry/junior" },
      artifactState: { assistantContextChannelId: "C456" },
      toolChannelId: "C456",
    });
    expect(services.deliverPrivateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U123",
        text: expect.stringContaining(
          "https://github.example.test/oauth/authorize",
        ),
      }),
    );
    expect(recordPendingAuth).toHaveBeenCalledWith({
      kind: "mcp",
      provider: "github",
      requesterId: "U123",
      sessionId: "scheduled:sched_1:1000",
      linkSentAtMs: 1_700_000_000_000,
    });
    expect(services.recordAuthorizationRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: "scheduled:sched_1:1000:mcp:github",
        delivery: "private_link_sent",
      }),
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("reuses a fresh pending auth link without delivering a duplicate link", async () => {
    const services = createMcpAuthServices();
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn(async () => undefined);
    const orchestration = createMcpAuthOrchestration(
      baseInput({
        recordPendingAuth,
        pendingAuth: {
          kind: "mcp",
          provider: "github",
          requesterId: "U123",
          sessionId: "scheduled:sched_1:1000",
          linkSentAtMs: 1_699_999_999_000,
        },
      }),
      abortAgent,
      services,
    );

    await orchestration.authProviderFactory(githubMcpPlugin);
    await expect(orchestration.onAuthorizationRequired("github")).resolves.toBe(
      true,
    );

    expect(services.deliverPrivateMessage).not.toHaveBeenCalled();
    expect(services.deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(recordPendingAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        linkSentAtMs: 1_699_999_999_000,
      }),
    );
    expect(services.recordAuthorizationRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: "scheduled:sched_1:1000:mcp:github",
        delivery: "private_link_reused",
      }),
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("deletes the auth session and does not abort when auth flow is disabled", async () => {
    const services = createMcpAuthServices();
    const abortAgent = vi.fn();
    const orchestration = createMcpAuthOrchestration(
      baseInput({ authorizationFlowMode: "disabled" }),
      abortAgent,
      services,
    );

    await orchestration.authProviderFactory(githubMcpPlugin);
    await expect(
      orchestration.onAuthorizationRequired("github"),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(services.deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(services.patchMcpAuthSession).not.toHaveBeenCalled();
    expect(services.deliverPrivateMessage).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });
});
