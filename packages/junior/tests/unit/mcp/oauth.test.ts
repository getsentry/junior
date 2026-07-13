import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

function buildPlugin() {
  return {
    dir: "/tmp/plugins/demo",
    skillsDir: "/tmp/plugins/demo/skills",
    manifest: {
      name: "demo",
      displayName: "Demo",
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
    vi.doMock("@/chat/plugins/catalog-runtime", () => ({
      pluginCatalogRuntime: {
        getDefinition: (provider: string) =>
          provider === "demo" ? buildPlugin() : undefined,
      },
    }));

    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.doUnmock("@/chat/plugins/catalog-runtime");
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("creates isolated lazy authorization attempts for the same turn", async () => {
    const { getMcpAuthSession } = await import("@/chat/mcp/auth-store");
    const { createMcpOAuthClientProvider } = await import("@/chat/mcp/oauth");

    const firstProvider = await createMcpOAuthClientProvider({
      provider: "demo",
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
      sessionId: "turn-1",
      userId: "U123",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      configuration: { region: "us" },
    });

    const secondProvider = await createMcpOAuthClientProvider({
      provider: "demo",
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
      sessionId: "turn-1",
      userId: "U123",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      toolChannelId: "C999",
      configuration: { region: "eu" },
      artifactState: { assistantContextChannelId: "C999" },
    });

    expect(secondProvider.authSessionId).not.toBe(firstProvider.authSessionId);
    await expect(
      getMcpAuthSession(firstProvider.authSessionId),
    ).resolves.toBeUndefined();
    await expect(
      getMcpAuthSession(secondProvider.authSessionId),
    ).resolves.toBeUndefined();

    await firstProvider.saveCodeVerifier("code-verifier");
    await firstProvider.redirectToAuthorization(
      new URL("https://auth.example.com/start"),
    );

    await expect(
      getMcpAuthSession(firstProvider.authSessionId),
    ).resolves.toMatchObject({
      schemaVersion: 2,
      authSessionId: firstProvider.authSessionId,
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
      sessionId: "turn-1",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      configuration: { region: "us" },
      authorizationUrl: "https://auth.example.com/start",
      codeVerifier: "code-verifier",
    });
    await expect(
      getMcpAuthSession(secondProvider.authSessionId),
    ).resolves.toBeUndefined();
  });
});
