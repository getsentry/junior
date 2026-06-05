import { beforeEach, describe, expect, it, vi } from "vitest";
import { StateBackedMcpOAuthClientProvider } from "@/chat/mcp/oauth-provider";

type ProviderSessionContext = ConstructorParameters<
  typeof StateBackedMcpOAuthClientProvider
>[2];
type ProviderServices = NonNullable<
  ConstructorParameters<typeof StateBackedMcpOAuthClientProvider>[3]
>;

describe("StateBackedMcpOAuthClientProvider credential state", () => {
  const services = {
    deleteMcpServerSessionId: vi.fn(),
    getMcpAuthSession: vi.fn(),
    getMcpServerSessionId: vi.fn(),
    getMcpStoredOAuthCredentials: vi.fn(),
    patchMcpAuthSession: vi.fn(),
    putMcpAuthSession: vi.fn(),
    putMcpServerSessionId: vi.fn(),
    putMcpStoredOAuthCredentials: vi.fn(),
  } satisfies ProviderServices;

  function createProvider(sessionContext?: ProviderSessionContext) {
    return new StateBackedMcpOAuthClientProvider(
      "auth-session-1",
      "https://junior.example.com/callback",
      sessionContext,
      services,
    );
  }

  beforeEach(() => {
    services.deleteMcpServerSessionId.mockReset();
    services.getMcpAuthSession.mockReset();
    services.getMcpServerSessionId.mockReset();
    services.getMcpStoredOAuthCredentials.mockReset();
    services.patchMcpAuthSession.mockReset();
    services.putMcpAuthSession.mockReset();
    services.putMcpServerSessionId.mockReset();
    services.putMcpStoredOAuthCredentials.mockReset();

    services.getMcpAuthSession.mockResolvedValue({
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
    services.getMcpStoredOAuthCredentials.mockResolvedValue({
      clientInformation: { client_id: "client-1" },
      discoveryState: { authorization_server: "https://example.com" },
      tokens: {
        access_token: "access",
        token_type: "Bearer",
      },
    });
    services.deleteMcpServerSessionId.mockResolvedValue(undefined);
    services.getMcpServerSessionId.mockResolvedValue(undefined);
    services.putMcpStoredOAuthCredentials.mockResolvedValue(undefined);
    services.putMcpServerSessionId.mockResolvedValue(undefined);
    services.putMcpAuthSession.mockResolvedValue(undefined);
    services.patchMcpAuthSession.mockResolvedValue(undefined);
  });

  it("preserves the authorization URL when only clearing the verifier", async () => {
    const provider = createProvider();

    await provider.invalidateCredentials("verifier");

    expect(services.putMcpStoredOAuthCredentials).toHaveBeenCalledWith(
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
    expect(services.patchMcpAuthSession).toHaveBeenCalledWith(
      "auth-session-1",
      {
        codeVerifier: undefined,
      },
    );
  });

  it("clears the authorization URL when invalidating all credentials", async () => {
    const provider = createProvider();

    await provider.invalidateCredentials("all");

    expect(services.putMcpStoredOAuthCredentials).toHaveBeenCalledWith(
      "U123",
      "demo",
      {},
    );
    expect(services.patchMcpAuthSession).toHaveBeenCalledWith(
      "auth-session-1",
      {
        codeVerifier: undefined,
        authorizationUrl: undefined,
      },
    );
  });

  it("reads stored credentials without requiring a persisted auth session", async () => {
    services.getMcpAuthSession.mockResolvedValue(undefined);

    const provider = createProvider({
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "/demo",
    });

    await expect(provider.tokens()).resolves.toEqual({
      access_token: "access",
      token_type: "Bearer",
    });
    expect(services.getMcpStoredOAuthCredentials).toHaveBeenCalledWith(
      "U123",
      "demo",
    );
  });

  it("creates the auth session lazily when redirecting to authorization", async () => {
    services.getMcpAuthSession.mockResolvedValue(undefined);

    const provider = createProvider({
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "/demo",
      channelId: "C123",
    });

    await provider.redirectToAuthorization(
      new URL("https://example.com/oauth/start"),
    );

    expect(services.putMcpAuthSession).toHaveBeenCalledWith(
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
    expect(services.patchMcpAuthSession).not.toHaveBeenCalled();
  });

  it("stores the opaque MCP server session outside agent-visible state", async () => {
    const provider = createProvider({
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "/demo",
    });

    await provider.saveMcpServerSessionId("mcp-session-123");

    expect(services.putMcpServerSessionId).toHaveBeenCalledWith(
      "U123",
      "demo",
      "mcp-session-123",
    );
    await expect(provider.getMcpServerSessionId()).resolves.toBeUndefined();
    expect(services.getMcpServerSessionId).toHaveBeenCalledWith("U123", "demo");
  });
});
