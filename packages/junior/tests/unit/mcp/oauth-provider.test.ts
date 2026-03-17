import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getMcpAuthSessionMock,
  getMcpStoredOAuthCredentialsMock,
  patchMcpAuthSessionMock,
  putMcpStoredOAuthCredentialsMock,
} = vi.hoisted(() => ({
  getMcpAuthSessionMock: vi.fn(),
  getMcpStoredOAuthCredentialsMock: vi.fn(),
  patchMcpAuthSessionMock: vi.fn(),
  putMcpStoredOAuthCredentialsMock: vi.fn(),
}));

vi.mock("@/chat/mcp/auth-store", () => ({
  getMcpAuthSession: getMcpAuthSessionMock,
  getMcpStoredOAuthCredentials: getMcpStoredOAuthCredentialsMock,
  patchMcpAuthSession: patchMcpAuthSessionMock,
  putMcpStoredOAuthCredentials: putMcpStoredOAuthCredentialsMock,
}));

import { StateBackedMcpOAuthClientProvider } from "@/chat/mcp/oauth-provider";

describe("StateBackedMcpOAuthClientProvider.invalidateCredentials", () => {
  beforeEach(() => {
    getMcpAuthSessionMock.mockReset();
    getMcpStoredOAuthCredentialsMock.mockReset();
    patchMcpAuthSessionMock.mockReset();
    putMcpStoredOAuthCredentialsMock.mockReset();

    getMcpAuthSessionMock.mockResolvedValue({
      authSessionId: "auth-session-1",
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "/demo",
      authorizationUrl: "https://example.com/oauth/start",
      codeVerifier: "code-verifier",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    getMcpStoredOAuthCredentialsMock.mockResolvedValue({
      clientInformation: { client_id: "client-1" },
      discoveryState: { authorization_server: "https://example.com" },
      tokens: {
        access_token: "access",
        token_type: "Bearer",
      },
    });
    putMcpStoredOAuthCredentialsMock.mockResolvedValue(undefined);
    patchMcpAuthSessionMock.mockResolvedValue(undefined);
  });

  it("preserves the authorization URL when only clearing the verifier", async () => {
    const provider = new StateBackedMcpOAuthClientProvider(
      "auth-session-1",
      "https://junior.example.com/callback",
    );

    await provider.invalidateCredentials("verifier");

    expect(putMcpStoredOAuthCredentialsMock).toHaveBeenCalledWith(
      "U123",
      "demo",
      {
        clientInformation: { client_id: "client-1" },
        discoveryState: { authorization_server: "https://example.com" },
        tokens: {
          access_token: "access",
          token_type: "Bearer",
        },
      },
    );
    expect(patchMcpAuthSessionMock).toHaveBeenCalledWith("auth-session-1", {
      codeVerifier: undefined,
    });
  });

  it("clears the authorization URL when invalidating all credentials", async () => {
    const provider = new StateBackedMcpOAuthClientProvider(
      "auth-session-1",
      "https://junior.example.com/callback",
    );

    await provider.invalidateCredentials("all");

    expect(putMcpStoredOAuthCredentialsMock).toHaveBeenCalledWith(
      "U123",
      "demo",
      {},
    );
    expect(patchMcpAuthSessionMock).toHaveBeenCalledWith("auth-session-1", {
      codeVerifier: undefined,
      authorizationUrl: undefined,
    });
  });
});
