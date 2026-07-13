import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };
const SLACK_DESTINATION = {
  platform: "slack",
  teamId: "T123",
  channelId: "C123",
} as const;

function buildSession(
  authSessionId: string,
  overrides: Partial<{
    provider: string;
    userId: string;
    conversationId: string;
    destination: typeof SLACK_DESTINATION;
    sessionId: string;
    userMessage: string;
  }> = {},
) {
  return {
    schemaVersion: 2 as const,
    authSessionId,
    provider: overrides.provider ?? "notion",
    userId: overrides.userId ?? "U123",
    conversationId: overrides.conversationId ?? "conversation-1",
    destination: overrides.destination ?? SLACK_DESTINATION,
    sessionId: overrides.sessionId ?? `turn-${authSessionId}`,
    userMessage: overrides.userMessage ?? "test notion skill",
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe("MCP auth session store", () => {
  beforeEach(async () => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_STATE_ADAPTER: "memory",
    };
    vi.resetModules();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
  });

  afterEach(async () => {
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("deletes every pending auth session for one user/provider pair", async () => {
    const {
      deleteMcpAuthSessionsForUserProvider,
      getMcpAuthSession,
      putMcpAuthSession,
    } = await import("@/chat/mcp/auth-store");

    await putMcpAuthSession(buildSession("auth-1"));
    await putMcpAuthSession(buildSession("auth-2"));
    await putMcpAuthSession(buildSession("auth-3", { provider: "github" }));
    await putMcpAuthSession(buildSession("auth-4", { userId: "U999" }));

    await deleteMcpAuthSessionsForUserProvider("U123", "notion");

    await expect(getMcpAuthSession("auth-1")).resolves.toBeUndefined();
    await expect(getMcpAuthSession("auth-2")).resolves.toBeUndefined();
    await expect(getMcpAuthSession("auth-3")).resolves.toEqual(
      expect.objectContaining({ authSessionId: "auth-3" }),
    );
    await expect(getMcpAuthSession("auth-4")).resolves.toEqual(
      expect.objectContaining({ authSessionId: "auth-4" }),
    );
  });

  it("ignores legacy attempt payloads stored under the v2 key", async () => {
    const { getMcpAuthSession } = await import("@/chat/mcp/auth-store");
    const { getStateAdapter } = await import("@/chat/state/adapter");
    const state = getStateAdapter();
    await state.connect();
    await state.set(
      "junior:mcp_oauth_attempt:v2:legacy-auth",
      JSON.stringify({
        ...buildSession("legacy-auth"),
        schemaVersion: 1,
      }),
    );

    await expect(getMcpAuthSession("legacy-auth")).resolves.toBeUndefined();
  });

  it("keeps bulk deletion working after one sibling session is removed directly", async () => {
    const {
      deleteMcpAuthSession,
      deleteMcpAuthSessionsForUserProvider,
      getMcpAuthSession,
      putMcpAuthSession,
    } = await import("@/chat/mcp/auth-store");

    await putMcpAuthSession(buildSession("auth-1"));
    await putMcpAuthSession(buildSession("auth-2"));
    await putMcpAuthSession(buildSession("auth-3", { provider: "github" }));

    await deleteMcpAuthSession("auth-1");
    await deleteMcpAuthSessionsForUserProvider("U123", "notion");

    await expect(getMcpAuthSession("auth-1")).resolves.toBeUndefined();
    await expect(getMcpAuthSession("auth-2")).resolves.toBeUndefined();
    await expect(getMcpAuthSession("auth-3")).resolves.toEqual(
      expect.objectContaining({ authSessionId: "auth-3" }),
    );
  });

  it("stores and clears the opaque MCP server session per user/provider", async () => {
    const {
      deleteMcpServerSessionId,
      getMcpServerSessionId,
      putMcpServerSessionId,
    } = await import("@/chat/mcp/auth-store");

    await putMcpServerSessionId("U123", "notion", "mcp-session-1");

    await expect(getMcpServerSessionId("U123", "notion")).resolves.toBe(
      "mcp-session-1",
    );
    await expect(getMcpServerSessionId("U123", "github")).resolves.toBe(
      undefined,
    );

    await deleteMcpServerSessionId("U123", "notion");

    await expect(getMcpServerSessionId("U123", "notion")).resolves.toBe(
      undefined,
    );
  });
});
