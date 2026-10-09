import { afterEach, describe, expect, it, vi } from "vitest";

const { mcpOauthCallbackGetMock } = vi.hoisted(() => ({
  mcpOauthCallbackGetMock: vi.fn(),
}));

vi.mock("@/handlers/mcp-oauth-callback", () => ({
  GET: mcpOauthCallbackGetMock,
}));

import { runMcpOauthCallbackRoute } from "../../fixtures/mcp-oauth-callback-harness";

describe("MCP OAuth callback harness", () => {
  afterEach(() => {
    mcpOauthCallbackGetMock.mockReset();
  });

  it("accepts an MCP OAuth callback that completes without background work", async () => {
    const response = new Response("ok", { status: 200 });
    mcpOauthCallbackGetMock.mockResolvedValue(response);

    // MCP callbacks queue continuation before returning, not in waitUntil().
    await expect(
      runMcpOauthCallbackRoute({
        provider: "eval-auth",
        state: "auth-session-1",
        code: "eval-auth-code",
      }),
    ).resolves.toBe(response);
  });

  it("fails when the MCP OAuth callback unexpectedly schedules background work", async () => {
    mcpOauthCallbackGetMock.mockImplementation(
      async (_request, _provider, waitUntil) => {
        waitUntil(Promise.resolve());
        return new Response("ok", { status: 200 });
      },
    );

    await expect(
      runMcpOauthCallbackRoute({
        provider: "eval-auth",
        state: "auth-session-1",
        code: "eval-auth-code",
        expectBackgroundWork: false,
      }),
    ).rejects.toThrow(
      'MCP OAuth callback route registered unexpected waitUntil() work for provider "eval-auth"',
    );
  });
});
