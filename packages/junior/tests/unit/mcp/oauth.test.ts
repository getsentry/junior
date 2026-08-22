import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const closeMock = vi.fn();
const finishAuthMock = vi.fn();
const transportOptions: Array<{ fetch?: typeof fetch }> = [];
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
    vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
      StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
        constructor(_url: URL, options: { fetch?: typeof fetch } = {}) {
          transportOptions.push(options);
        }

        async finishAuth(code: string) {
          return await finishAuthMock(code, transportOptions.at(-1));
        }

        async close() {
          return await closeMock();
        }
      },
    }));
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
    finishAuthMock.mockReset();
    transportOptions.length = 0;

    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.doUnmock("@/chat/plugins/catalog-runtime");
    vi.doUnmock("@modelcontextprotocol/sdk/client/streamableHttp.js");
    vi.resetModules();
    globalThis.fetch = ORIGINAL_FETCH;
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

  it("sanitizes and bounds provider errors from the callback exchange", async () => {
    const secrets = [
      "https://auth.example.com/authorize?code=authorization-code",
      "access-token-value",
      "client-secret-value",
      "<script>alert('provider')</script>",
    ];
    let cancelled = false;
    const prefix = new TextEncoder().encode(secrets.join(" "));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(prefix);
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = (vi.fn(async () => new Response(body, { status: 502 })) as typeof fetch);
    finishAuthMock.mockImplementation(
      async (_code: string, options: { fetch?: typeof fetch } | undefined) => {
        const response = await options?.fetch?.(
          "https://mcp.example.com/token",
        );
        throw new Error(await response?.text());
      },
    );

    const { createMcpOAuthClientProvider, finalizeMcpAuthorization } =
      await import("@/chat/mcp/oauth");
    const { McpProviderError } = await import("@/chat/mcp/errors");
    const authProvider = await createMcpOAuthClientProvider({
      provider: "demo",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userId: "U123",
      userMessage: "use /demo",
    });
    await authProvider.saveCodeVerifier("code-verifier");

    const error = await finalizeMcpAuthorization(
      "demo",
      authProvider.authSessionId,
      "authorization-code",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(McpProviderError);
    expect(error).toMatchObject({
      phase: "oauth_callback",
      provider: "demo",
      resourceHost: "mcp.example.com",
      status: 502,
    });
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    for (const secret of secrets) {
      expect((error as Error).message).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
    expect(cancelled).toBe(true);
    expect(closeMock).toHaveBeenCalledOnce();
  });
});
