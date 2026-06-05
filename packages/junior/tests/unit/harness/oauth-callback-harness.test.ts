import { afterEach, describe, expect, it, vi } from "vitest";
import { runOauthCallbackRoute } from "../../fixtures/oauth-callback-harness";
import { runMcpOauthCallbackRoute } from "../../fixtures/mcp-oauth-callback-harness";

describe("oauth callback harnesses", () => {
  const oauthCallbackGet = vi.fn();
  const mcpOauthCallbackGet = vi.fn();

  afterEach(() => {
    oauthCallbackGet.mockReset();
    mcpOauthCallbackGet.mockReset();
  });

  it.each([
    {
      label: "generic OAuth",
      run: () =>
        runOauthCallbackRoute({
          provider: "eval-oauth",
          state: "oauth-state-1",
          code: "eval-oauth-code",
          handler: oauthCallbackGet,
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
          handler: mcpOauthCallbackGet,
        }),
      expectedError:
        'MCP OAuth callback route returned 200 without registering waitUntil() work for provider "eval-auth"',
    },
  ])(
    "fails when the $label callback route returns success without registering waitUntil() work",
    async ({ run, expectedError }) => {
      oauthCallbackGet.mockResolvedValue(new Response("ok", { status: 200 }));
      mcpOauthCallbackGet.mockResolvedValue(
        new Response("ok", { status: 200 }),
      );

      await expect(run()).rejects.toThrow(expectedError);
    },
  );
});
