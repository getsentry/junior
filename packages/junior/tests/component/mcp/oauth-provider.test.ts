import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMcpAuthSession,
  getMcpServerSessionId,
  getMcpStoredOAuthCredentials,
  putMcpAuthSession,
  putMcpStoredOAuthCredentials,
} from "@/chat/mcp/auth-store";
import { StateBackedMcpOAuthClientProvider } from "@/chat/mcp/oauth-provider";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import {
  DEFAULT_TEST_NOW_MS,
  mockTestClock,
  stubTestEnv,
} from "../../fixtures/vitest";

type ProviderSessionContext = NonNullable<
  ConstructorParameters<typeof StateBackedMcpOAuthClientProvider>[2]
>;

const SESSION_CONTEXT: ProviderSessionContext = {
  provider: "demo",
  userId: "U123",
  conversationId: "conversation-1",
  sessionId: "turn-1",
  userMessage: "/demo",
};

function createProvider(sessionContext?: ProviderSessionContext) {
  return new StateBackedMcpOAuthClientProvider(
    "auth-session-1",
    "https://junior.example.com/callback",
    sessionContext,
  );
}

async function seedSession(): Promise<void> {
  await putMcpAuthSession({
    authSessionId: "auth-session-1",
    ...SESSION_CONTEXT,
    authorizationUrl: "https://example.com/oauth/start",
    codeVerifier: "code-verifier",
    createdAtMs: 1,
    updatedAtMs: 1,
  });
}

async function seedCredentials(): Promise<void> {
  await putMcpStoredOAuthCredentials("U123", "demo", {
    clientInformation: { client_id: "client-1" },
    discoveryState: { authorizationServerUrl: "https://example.com" },
    tokens: {
      access_token: "access",
      token_type: "Bearer",
    },
  });
}

describe("StateBackedMcpOAuthClientProvider credential state", () => {
  beforeEach(async () => {
    stubTestEnv({ JUNIOR_STATE_ADAPTER: "memory" });
    mockTestClock();
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("preserves the authorization URL when only clearing the verifier", async () => {
    await seedSession();
    await seedCredentials();
    const provider = createProvider();

    await provider.invalidateCredentials("verifier");

    await expect(getMcpStoredOAuthCredentials("U123", "demo")).resolves.toEqual(
      {
        clientInformation: { client_id: "client-1" },
        discoveryState: { authorizationServerUrl: "https://example.com" },
        tokens: {
          access_token: "access",
          token_type: "Bearer",
        },
      },
    );
    await expect(getMcpAuthSession("auth-session-1")).resolves.toMatchObject({
      authorizationUrl: "https://example.com/oauth/start",
      updatedAtMs: DEFAULT_TEST_NOW_MS,
    });
    expect(
      (await getMcpAuthSession("auth-session-1"))?.codeVerifier,
    ).toBeUndefined();
  });

  it("clears the authorization URL when invalidating all credentials", async () => {
    await seedSession();
    await seedCredentials();
    const provider = createProvider();

    await provider.invalidateCredentials("all");

    await expect(getMcpStoredOAuthCredentials("U123", "demo")).resolves.toEqual(
      {},
    );
    const session = await getMcpAuthSession("auth-session-1");
    expect(session?.authorizationUrl).toBeUndefined();
    expect(session?.codeVerifier).toBeUndefined();
  });

  it("reads stored credentials without requiring a persisted auth session", async () => {
    await seedCredentials();
    const provider = createProvider(SESSION_CONTEXT);

    await expect(provider.tokens()).resolves.toEqual({
      access_token: "access",
      token_type: "Bearer",
    });
  });

  it("creates the auth session lazily when redirecting to authorization", async () => {
    const provider = createProvider({
      ...SESSION_CONTEXT,
      channelId: "C123",
    });

    await provider.redirectToAuthorization(
      new URL("https://example.com/oauth/start"),
    );

    await expect(getMcpAuthSession("auth-session-1")).resolves.toMatchObject({
      authSessionId: "auth-session-1",
      provider: "demo",
      userId: "U123",
      conversationId: "conversation-1",
      sessionId: "turn-1",
      userMessage: "/demo",
      channelId: "C123",
      authorizationUrl: "https://example.com/oauth/start",
      createdAtMs: DEFAULT_TEST_NOW_MS,
      updatedAtMs: DEFAULT_TEST_NOW_MS,
    });
  });

  it("stores the opaque MCP server session outside agent-visible state", async () => {
    const provider = createProvider(SESSION_CONTEXT);

    await provider.saveMcpServerSessionId("mcp-session-123");

    await expect(getMcpServerSessionId("U123", "demo")).resolves.toBe(
      "mcp-session-123",
    );
    await expect(provider.getMcpServerSessionId()).resolves.toBe(
      "mcp-session-123",
    );

    await provider.saveMcpServerSessionId(undefined);

    await expect(
      getMcpServerSessionId("U123", "demo"),
    ).resolves.toBeUndefined();
  });
});
