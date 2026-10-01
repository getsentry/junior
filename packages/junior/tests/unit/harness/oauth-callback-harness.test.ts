import { afterEach, describe, expect, it, vi } from "vitest";

const { oauthCallbackGetMock, mcpOauthCallbackGetMock } = vi.hoisted(() => ({
  oauthCallbackGetMock: vi.fn(),
  mcpOauthCallbackGetMock: vi.fn(),
}));

vi.mock("@/handlers/oauth-callback", () => ({
  GET: oauthCallbackGetMock,
}));

vi.mock("@/handlers/mcp-oauth-callback", () => ({
  GET: mcpOauthCallbackGetMock,
}));

import { runOauthCallbackRoute } from "../../fixtures/oauth-callback-harness";
import { runMcpOauthCallbackRoute } from "../../fixtures/mcp-oauth-callback-harness";

describe("oauth callback harnesses", () => {
  afterEach(() => {
    oauthCallbackGetMock.mockReset();
    mcpOauthCallbackGetMock.mockReset();
  });

  it("fails when the generic OAuth callback omits expected background work", async () => {
    oauthCallbackGetMock.mockResolvedValue(new Response("ok", { status: 200 }));

    await expect(
      runOauthCallbackRoute({
        provider: "eval-oauth",
        state: "oauth-state-1",
        code: "eval-oauth-code",
      }),
    ).rejects.toThrow(
      'OAuth callback route returned 200 without registering waitUntil() work for provider "eval-oauth"',
    );
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

  it.each([
    {
      label: "generic OAuth",
      run: () =>
        runOauthCallbackRoute({
          provider: "eval-oauth",
          state: "oauth-state-1",
          code: "eval-oauth-code",
          expectBackgroundWork: false,
        }),
      expectedError:
        'OAuth callback route registered unexpected waitUntil() work for provider "eval-oauth"',
    },
    {
      label: "MCP OAuth",
      run: () =>
        runMcpOauthCallbackRoute({
          provider: "eval-auth",
          state: "auth-session-1",
          code: "eval-auth-code",
          expectBackgroundWork: false,
        }),
      expectedError:
        'MCP OAuth callback route registered unexpected waitUntil() work for provider "eval-auth"',
    },
  ])(
    "fails when the $label callback unexpectedly schedules background work",
    async ({ run, expectedError }) => {
      const response = new Response("ok", { status: 200 });
      oauthCallbackGetMock.mockImplementation(
        async (_request, _provider, waitUntil) => {
          waitUntil(Promise.resolve());
          return response;
        },
      );
      mcpOauthCallbackGetMock.mockImplementation(
        async (_request, _provider, waitUntil) => {
          waitUntil(Promise.resolve());
          return response;
        },
      );

      await expect(run()).rejects.toThrow(expectedError);
    },
  );
});
