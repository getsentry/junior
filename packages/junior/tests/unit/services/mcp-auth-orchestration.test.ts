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
} = vi.hoisted(() => ({
  createMcpOAuthClientProvider: vi.fn(),
  deleteMcpAuthSession: vi.fn(),
  deliverPrivateMessage: vi.fn(),
  formatProviderLabel: vi.fn((provider: string) => provider),
  getMcpAuthSession: vi.fn(),
  patchMcpAuthSession: vi.fn(),
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
    expect(deleteMcpAuthSession).not.toHaveBeenCalled();
    expect(recordPendingAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "mcp",
        provider: "github",
        actorId: "U123",
        sessionId: "run_new",
      }),
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });
});
