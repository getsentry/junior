import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function buildPlugin() {
  return {
    dir: "/tmp/plugins/demo",
    skillsDir: "/tmp/plugins/demo/skills",
    manifest: {
      name: "demo",
      description: "Demo plugin",
      capabilities: [],
      configKeys: [],
      mcp: {
        transport: "http" as const,
        url: "https://mcp.example.com",
      },
    },
  };
}

describe("createMcpOAuthClientProvider", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    vi.doMock("@/chat/plugins/registry", () => ({
      getPluginDefinition: (provider: string) =>
        provider === "demo" ? buildPlugin() : undefined,
    }));

    const { disconnectStateAdapter } = await import("@/chat/state");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state");
    await disconnectStateAdapter();
    vi.unmock("@/chat/plugins/registry");
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("persists and reuses the pending auth session for the same turn", async () => {
    const { getMcpAuthSession, patchMcpAuthSession } =
      await import("@/chat/mcp/auth-store");
    const { createMcpOAuthClientProvider } = await import("@/chat/mcp/oauth");

    const firstProvider = await createMcpOAuthClientProvider({
      provider: "demo",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userId: "U123",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      configuration: { region: "us" },
    });

    const initialSession = await getMcpAuthSession(firstProvider.authSessionId);
    expect(initialSession).toMatchObject({
      authSessionId: firstProvider.authSessionId,
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      configuration: { region: "us" },
    });

    await patchMcpAuthSession(firstProvider.authSessionId, {
      authorizationUrl: "https://auth.example.com/start",
      codeVerifier: "code-verifier",
    });

    const reusedProvider = await createMcpOAuthClientProvider({
      provider: "demo",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userId: "U123",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      toolChannelId: "C999",
      configuration: { region: "eu" },
      artifactState: { assistantContextChannelId: "C999" },
    });

    expect(reusedProvider.authSessionId).toBe(firstProvider.authSessionId);

    const reusedSession = await getMcpAuthSession(reusedProvider.authSessionId);
    expect(reusedSession).toMatchObject({
      authSessionId: firstProvider.authSessionId,
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      toolChannelId: "C999",
      configuration: { region: "eu" },
      artifactState: { assistantContextChannelId: "C999" },
      authorizationUrl: "https://auth.example.com/start",
      codeVerifier: "code-verifier",
    });
    expect(reusedSession?.createdAtMs).toBe(initialSession?.createdAtMs);
    expect(reusedSession?.updatedAtMs).toBeGreaterThanOrEqual(
      initialSession?.updatedAtMs ?? 0,
    );
  });
});
