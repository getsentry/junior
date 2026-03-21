import { afterEach, describe, expect, it, vi } from "vitest";

const { routerGetMock } = vi.hoisted(() => ({
  routerGetMock: vi.fn(),
}));

vi.mock("@/handlers/router", () => ({
  GET: routerGetMock,
}));

import { runOauthCallbackRoute } from "../../fixtures/oauth-callback-harness";
import { runMcpOauthCallbackRoute } from "../../fixtures/mcp-oauth-callback-harness";

describe("oauth callback harnesses", () => {
  afterEach(() => {
    routerGetMock.mockReset();
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
        'OAuth callback route returned 200 without registering after() work for provider "eval-oauth"',
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
        'MCP OAuth callback route returned 200 without registering after() work for provider "eval-auth"',
    },
  ])(
    "fails when the $label callback route returns success without registering after() work",
    async ({ run, expectedError }) => {
      routerGetMock.mockResolvedValue(new Response("ok", { status: 200 }));

      await expect(run()).rejects.toThrow(expectedError);
    },
  );
});
