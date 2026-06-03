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

  it.each([
    {
      label: "generic OAuth",
      run: () =>
        runOauthCallbackRoute({
          provider: "eval-oauth",
          state: "oauth-state-1",
          code: "eval-oauth-code",
        }),
      expectedError:
        'OAuth callback route returned 200 without registering waitUntil() work for provider "eval-oauth"',
    },
    {
      label: "MCP OAuth",
      run: () =>
        runMcpOauthCallbackRoute({
          provider: "eval-auth",
          state: "auth-session-1",
          code: "eval-auth-code",
        }),
      expectedError:
        'MCP OAuth callback route returned 200 without registering waitUntil() work for provider "eval-auth"',
    },
  ])(
    "fails when the $label callback route returns success without registering waitUntil() work",
    async ({ run, expectedError }) => {
      oauthCallbackGetMock.mockResolvedValue(
        new Response("ok", { status: 200 }),
      );
      mcpOauthCallbackGetMock.mockResolvedValue(
        new Response("ok", { status: 200 }),
      );

      await expect(run()).rejects.toThrow(expectedError);
    },
  );
});
