import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  deleteMcpServerSessionIdMock,
  getMcpAuthSessionMock,
  getMcpServerSessionIdMock,
  getMcpStoredOAuthCredentialsMock,
  patchMcpAuthSessionMock,
  putMcpServerSessionIdMock,
  putMcpAuthSessionMock,
  putMcpStoredOAuthCredentialsMock,
} = vi.hoisted(() => ({
  deleteMcpServerSessionIdMock: vi.fn(),
  getMcpAuthSessionMock: vi.fn(),
  getMcpServerSessionIdMock: vi.fn(),
  getMcpStoredOAuthCredentialsMock: vi.fn(),
  patchMcpAuthSessionMock: vi.fn(),
  putMcpServerSessionIdMock: vi.fn(),
  putMcpAuthSessionMock: vi.fn(),
  putMcpStoredOAuthCredentialsMock: vi.fn(),
}));

vi.mock("@/chat/mcp/auth-store", () => ({
  deleteMcpServerSessionId: deleteMcpServerSessionIdMock,
  getMcpAuthSession: getMcpAuthSessionMock,
  getMcpServerSessionId: getMcpServerSessionIdMock,
  getMcpStoredOAuthCredentials: getMcpStoredOAuthCredentialsMock,
  patchMcpAuthSession: patchMcpAuthSessionMock,
  putMcpServerSessionId: putMcpServerSessionIdMock,
  putMcpAuthSession: putMcpAuthSessionMock,
  putMcpStoredOAuthCredentials: putMcpStoredOAuthCredentialsMock,
}));

import { StateBackedMcpOAuthClientProvider } from "@/chat/mcp/oauth-provider";

describe("StateBackedMcpOAuthClientProvider.invalidateCredentials", () => {
  beforeEach(() => {
    deleteMcpServerSessionIdMock.mockReset();
    getMcpAuthSessionMock.mockReset();
    getMcpServerSessionIdMock.mockReset();
    getMcpStoredOAuthCredentialsMock.mockReset();
    patchMcpAuthSessionMock.mockReset();
    putMcpServerSessionIdMock.mockReset();
    putMcpAuthSessionMock.mockReset();
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
    deleteMcpServerSessionIdMock.mockResolvedValue(undefined);
    getMcpServerSessionIdMock.mockResolvedValue(undefined);
    putMcpStoredOAuthCredentialsMock.mockResolvedValue(undefined);
    putMcpServerSessionIdMock.mockResolvedValue(undefined);
    putMcpAuthSessionMock.mockResolvedValue(undefined);
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

  it("reads stored credentials without requiring a persisted auth session", async () => {
    getMcpAuthSessionMock.mockResolvedValue(undefined);

    const provider = new StateBackedMcpOAuthClientProvider(
      "auth-session-1",
      "https://junior.example.com/callback",
      {
        provider: "demo",
        userId: "U123",
        conversationId: "conversation-1",
        sessionId: "turn-1",
        userMessage: "/demo",
      },
    );

    await expect(provider.tokens()).resolves.toEqual({
      access_token: "access",
      token_type: "Bearer",
    });
    expect(getMcpStoredOAuthCredentialsMock).toHaveBeenCalledWith(
      "U123",
      "demo",
    );
  });

  it("creates the auth session lazily when redirecting to authorization", async () => {
    getMcpAuthSessionMock.mockResolvedValue(undefined);

    const provider = new StateBackedMcpOAuthClientProvider(
      "auth-session-1",
      "https://junior.example.com/callback",
      {
        provider: "demo",
        userId: "U123",
        conversationId: "conversation-1",
        sessionId: "turn-1",
        userMessage: "/demo",
        channelId: "C123",
      },
    );

    await provider.redirectToAuthorization(
      new URL("https://example.com/oauth/start"),
    );

    expect(putMcpAuthSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        authSessionId: "auth-session-1",
        provider: "demo",
        userId: "U123",
        conversationId: "conversation-1",
        sessionId: "turn-1",
        userMessage: "/demo",
        channelId: "C123",
        authorizationUrl: "https://example.com/oauth/start",
      }),
    );
    expect(patchMcpAuthSessionMock).not.toHaveBeenCalled();
  });

  it("stores the opaque MCP server session outside agent-visible state", async () => {
    const provider = new StateBackedMcpOAuthClientProvider(
      "auth-session-1",
      "https://junior.example.com/callback",
      {
        provider: "demo",
        userId: "U123",
        conversationId: "conversation-1",
        sessionId: "turn-1",
        userMessage: "/demo",
      },
    );

    await provider.saveMcpServerSessionId("mcp-session-123");

    expect(putMcpServerSessionIdMock).toHaveBeenCalledWith(
      "U123",
      "demo",
      "mcp-session-123",
    );
    await expect(provider.getMcpServerSessionId()).resolves.toBeUndefined();
    expect(getMcpServerSessionIdMock).toHaveBeenCalledWith("U123", "demo");
  });
});
