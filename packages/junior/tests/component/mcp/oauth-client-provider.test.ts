import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMcpAuthSession, patchMcpAuthSession } from "@/chat/mcp/auth-store";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import { setPluginCatalogConfig } from "@/chat/plugins/registry";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  DEFAULT_TEST_NOW_MS,
  mockTestClock,
  stubTestEnv,
} from "../../fixtures/vitest";

const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

function registerMcpPlugin(): void {
  setPluginCatalogConfig({
    inlineManifests: [
      {
        manifest: {
          name: "demo",
          description: "Demo plugin",
          capabilities: [],
          configKeys: [],
          mcp: {
            transport: "http",
            url: "https://mcp.example.com",
          },
        },
      },
    ],
  });
}

describe("MCP OAuth client provider session state", () => {
  beforeEach(async () => {
    stubTestEnv({
      JUNIOR_BASE_URL: "https://junior.example.com",
      JUNIOR_STATE_ADAPTER: "memory",
    });
    mockTestClock();
    registerMcpPlugin();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    setPluginCatalogConfig(undefined);
    await disconnectStateAdapter();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("persists and reuses the pending auth session for the same turn", async () => {
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

    const initialSession = await getMcpAuthSession(firstProvider.authSessionId);
    expect(initialSession).toMatchObject({
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
      createdAtMs: DEFAULT_TEST_NOW_MS,
      updatedAtMs: DEFAULT_TEST_NOW_MS,
    });

    await patchMcpAuthSession(firstProvider.authSessionId, {
      authorizationUrl: "https://auth.example.com/start",
      codeVerifier: "code-verifier",
    });
    vi.setSystemTime(new Date(DEFAULT_TEST_NOW_MS + 5_000));

    const reusedProvider = await createMcpOAuthClientProvider({
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

    expect(reusedProvider.authSessionId).toBe(firstProvider.authSessionId);
    expect(reusedProvider.redirectUrl).toBe(
      "https://junior.example.com/api/oauth/callback/mcp/demo",
    );

    const reusedSession = await getMcpAuthSession(reusedProvider.authSessionId);
    expect(reusedSession).toMatchObject({
      authSessionId: firstProvider.authSessionId,
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      destination: SLACK_DESTINATION,
      sessionId: "turn-1",
      userMessage: "use /demo",
      channelId: "C123",
      threadTs: "1712345.0001",
      toolChannelId: "C999",
      configuration: { region: "eu" },
      artifactState: { assistantContextChannelId: "C999" },
      authorizationUrl: "https://auth.example.com/start",
      codeVerifier: "code-verifier",
      createdAtMs: DEFAULT_TEST_NOW_MS,
      updatedAtMs: DEFAULT_TEST_NOW_MS + 5_000,
    });
  });
});
