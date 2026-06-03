import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpAuthOrchestration } from "@/chat/services/mcp-auth-orchestration";
import { AuthorizationFlowDisabledError } from "@/chat/services/auth-pause";

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
    const orchestration = createMcpAuthOrchestration(
      {
        conversationId: "slack:C123:1700000000.000000",
        sessionId: "scheduled:sched_1:1000",
        requesterId: "U123",
        channelId: "C123",
        threadTs: "1700000000.000000",
        userMessage: "<scheduled-task-run />",
        getConfiguration: () => ({}),
        getArtifactState: () => undefined,
        getMergedArtifactState: () => ({}),
        authorizationFlowMode: "disabled",
      },
      abortAgent,
    );

    await orchestration.authProviderFactory({
      manifest: {
        name: "github",
      },
    } as any);

    await expect(
      orchestration.onAuthorizationRequired("github"),
    ).rejects.toBeInstanceOf(AuthorizationFlowDisabledError);

    expect(deleteMcpAuthSession).toHaveBeenCalledWith("auth_1");
    expect(patchMcpAuthSession).not.toHaveBeenCalled();
    expect(getMcpAuthSession).not.toHaveBeenCalled();
    expect(deliverPrivateMessage).not.toHaveBeenCalled();
    expect(abortAgent).not.toHaveBeenCalled();
  });
});
