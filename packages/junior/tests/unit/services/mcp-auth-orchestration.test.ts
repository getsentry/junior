import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackSource } from "@sentry/junior-plugin-api";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";
import type { PluginDefinition } from "@/chat/plugins/types";

const {
  createMcpOAuthClientProvider,
  deleteMcpAuthSession,
  deliverPrivateMessage,
  formatProviderLabel,
  getMcpAuthSession,
  patchMcpAuthSession,
  abandonAgentTurnSessionRecord,
} = vi.hoisted(() => ({
  createMcpOAuthClientProvider: vi.fn(),
  deleteMcpAuthSession: vi.fn(),
  deliverPrivateMessage: vi.fn(),
  formatProviderLabel: vi.fn((provider: string) => provider),
  getMcpAuthSession: vi.fn(),
  patchMcpAuthSession: vi.fn(),
  abandonAgentTurnSessionRecord: vi.fn(),
}));

vi.mock("@/chat/mcp/oauth", () => ({
  createMcpOAuthClientProvider,
}));

vi.mock("@/chat/mcp/auth-store", () => ({
  deleteMcpAuthSession,
  getMcpAuthSession,
  patchMcpAuthSession,
}));

vi.mock("@/chat/oauth-flow", () => ({
  deliverPrivateMessage,
  formatProviderLabel,
}));

vi.mock("@/chat/state/turn-session", () => ({
  abandonAgentTurnSessionRecord,
}));

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

const slackSource = createSlackSource({
  teamId: "T123",
  channelId: "C123",
  messageTs: "1700000000.source",
  threadTs: "1700000000.000000",
  type: "priv",
});

describe("createMcpAuthOrchestration", () => {
  beforeEach(() => {
    createMcpOAuthClientProvider.mockReset();
    createMcpOAuthClientProvider.mockResolvedValue({
      authSessionId: "auth_1",
    });
    deleteMcpAuthSession.mockReset();
    deliverPrivateMessage.mockReset();
    formatProviderLabel.mockClear();
    getMcpAuthSession.mockReset();
    patchMcpAuthSession.mockReset();
    abandonAgentTurnSessionRecord.mockReset();
  });

  it("returns a deterministic error instead of delivering auth links when authorization is disabled", async () => {
    const abortAgent = vi.fn();
    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "scheduled:sched_1:1000",
      actorId: "U123",
      channelId: "C123",
      source: slackSource,
      threadTs: "1700000000.000000",
      userMessage: "<scheduled-task-run />",
      getConfiguration: () => ({}),
      getArtifactState: () => undefined,
      getMergedArtifactState: () => ({}),
      authorizationFlowMode: "disabled",
    });

    await orchestration.authProviderFactory(plugin("github"));

    await expect(
      orchestration.onAuthorizationRequired("github"),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(createMcpOAuthClientProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        source: slackSource,
      }),
    );
    expect(patchMcpAuthSession).not.toHaveBeenCalled();
    expect(getMcpAuthSession).not.toHaveBeenCalled();
    expect(deliverPrivateMessage).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });

  it("fails before preparing and delivering an auth link when pending auth cannot be recorded", async () => {
    const abortAgent = vi.fn();
    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      actorId: "U123",
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
      actorId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userMessage: "use MCP",
      pendingAuth: {
        authSessionId: "github-auth-session",
        kind: "mcp",
        provider: "github",
        actorId: "U123",
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
    expect(patchMcpAuthSession).toHaveBeenCalledWith("auth_1", {
      configuration: {},
      artifactState: {},
      toolChannelId: "C123",
    });
    expect(getMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(deleteMcpAuthSession).not.toHaveBeenCalled();
    expect(recordPendingAuth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: "mcp",
        provider: "github",
        actorId: "U123",
        sessionId: "run_new",
      }),
    );
    expect(recordPendingAuth).toHaveBeenCalledTimes(1);
    expect(abandonAgentTurnSessionRecord).toHaveBeenCalledWith({
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_old",
      errorMessage:
        "Abandoned by a newer auth-blocked request in the same conversation.",
    });
    expect(recordPendingAuth.mock.invocationCallOrder[0]).toBeLessThan(
      deliverPrivateMessage.mock.invocationCallOrder[0]!,
    );
    expect(patchMcpAuthSession.mock.invocationCallOrder[0]).toBeLessThan(
      getMcpAuthSession.mock.invocationCallOrder[0]!,
    );
    expect(getMcpAuthSession.mock.invocationCallOrder[0]).toBeLessThan(
      recordPendingAuth.mock.invocationCallOrder[0]!,
    );
    expect(deliverPrivateMessage.mock.invocationCallOrder[0]).toBeLessThan(
      abandonAgentTurnSessionRecord.mock.invocationCallOrder[0]!,
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("updates the surviving attempt when reusing a pending link", async () => {
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn();
    const pendingAuth = {
      authSessionId: "auth_existing",
      kind: "mcp" as const,
      provider: "github",
      actorId: "U123",
      sessionId: "run_1",
      linkSentAtMs: Date.now(),
    };

    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_1",
      actorId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userMessage: "use MCP",
      pendingAuth,
      getConfiguration: () => ({ region: "us" }),
      getArtifactState: () => undefined,
      getMergedArtifactState: () => ({
        assistantContextChannelId: "C-tools",
      }),
      recordPendingAuth,
    });

    await orchestration.authProviderFactory(plugin("github"));

    await expect(orchestration.onAuthorizationRequired("github")).resolves.toBe(
      true,
    );

    expect(patchMcpAuthSession).toHaveBeenCalledWith("auth_existing", {
      configuration: { region: "us" },
      artifactState: { assistantContextChannelId: "C-tools" },
      toolChannelId: "C-tools",
    });
    expect(deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(getMcpAuthSession).not.toHaveBeenCalled();
    expect(deliverPrivateMessage).not.toHaveBeenCalled();
    expect(recordPendingAuth).toHaveBeenCalledWith(pendingAuth);
    expect(abandonAgentTurnSessionRecord).not.toHaveBeenCalled();
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("restores the prior pending attempt when private link delivery fails", async () => {
    const abortAgent = vi.fn();
    const recordPendingAuth = vi.fn();
    const previousPendingAuth = {
      authSessionId: "auth_old",
      kind: "mcp" as const,
      provider: "github",
      actorId: "U123",
      sessionId: "run_old",
      linkSentAtMs: 1,
    };
    getMcpAuthSession.mockResolvedValue({
      authorizationUrl: "https://mcp.example/authorize",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userId: "U123",
    });
    deliverPrivateMessage.mockResolvedValue(false);

    const orchestration = createMcpAuthOrchestration({
      abortAgent,
      conversationId: "slack:C123:1700000000.000000",
      sessionId: "run_new",
      actorId: "U123",
      channelId: "C123",
      threadTs: "1700000000.000000",
      userMessage: "use MCP",
      pendingAuth: previousPendingAuth,
      getConfiguration: () => ({}),
      getArtifactState: () => undefined,
      getMergedArtifactState: () => ({}),
      recordPendingAuth,
    });

    await orchestration.authProviderFactory(plugin("github"));

    await expect(
      orchestration.onAuthorizationRequired("github"),
    ).rejects.toThrow(
      'Unable to deliver MCP authorization link for plugin "github"',
    );

    expect(recordPendingAuth).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ authSessionId: "auth_1" }),
    );
    expect(deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(recordPendingAuth).toHaveBeenNthCalledWith(2, previousPendingAuth);
    expect(abandonAgentTurnSessionRecord).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });
});
