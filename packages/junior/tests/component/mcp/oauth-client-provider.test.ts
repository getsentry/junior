import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getLatestMcpAuthSessionForUserProvider,
  getMcpAuthSession,
  patchMcpAuthSession,
  putMcpAuthSession,
} from "@/chat/mcp/auth-store";
import { createMcpOAuthClientProvider } from "@/chat/mcp/oauth";
import type { PluginDefinition } from "@/chat/plugins/types";
import { disconnectStateAdapter } from "@/chat/state/adapter";

const ORIGINAL_ENV = { ...process.env };
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

type McpOAuthServices = NonNullable<
  Parameters<typeof createMcpOAuthClientProvider>[1]
>;

function buildPlugin(): PluginDefinition {
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

const mcpOAuthServices = {
  getLatestMcpAuthSessionForUserProvider,
  getPluginDefinition: (provider: string) =>
    provider === "demo" ? buildPlugin() : undefined,
  newAuthSessionId: () => "demo-auth-session",
  now: () => 1_700_000_000_000,
  putMcpAuthSession,
  resolveBaseUrl: () => "https://junior.example.com",
} satisfies McpOAuthServices;

describe("MCP OAuth client provider session state", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("persists and reuses the pending auth session for the same turn", async () => {
    const firstProvider = await createMcpOAuthClientProvider(
      {
        provider: "demo",
        conversationId: "conversation-1",
        destination: SLACK_DESTINATION,
        sessionId: "turn-1",
        userId: "U123",
        userMessage: "use /demo",
        channelId: "C123",
        threadTs: "1712345.0001",
        configuration: { region: "us" },
      },
      mcpOAuthServices,
    );

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
    });

    await patchMcpAuthSession(firstProvider.authSessionId, {
      authorizationUrl: "https://auth.example.com/start",
      codeVerifier: "code-verifier",
    });

    const reusedProvider = await createMcpOAuthClientProvider(
      {
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
      },
      mcpOAuthServices,
    );

    expect(reusedProvider.authSessionId).toBe(firstProvider.authSessionId);

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
    });
    expect(reusedSession?.createdAtMs).toBe(initialSession?.createdAtMs);
    expect(reusedSession?.updatedAtMs).toBeGreaterThanOrEqual(
      initialSession?.updatedAtMs ?? 0,
    );
  });
});
