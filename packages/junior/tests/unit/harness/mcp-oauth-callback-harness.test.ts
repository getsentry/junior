import { afterEach, describe, expect, it, vi } from "vitest";

const { routerGetMock } = vi.hoisted(() => ({
  routerGetMock: vi.fn(),
}));

vi.mock("@/handlers/router", () => ({
  GET: routerGetMock,
}));

import { runMcpOauthCallbackRoute } from "../../fixtures/mcp-oauth-callback-harness";

describe("mcp oauth callback harness", () => {
  afterEach(() => {
    routerGetMock.mockReset();
  });

  it("fails when the callback route returns success without registering after() work", async () => {
    routerGetMock.mockResolvedValue(new Response("ok", { status: 200 }));

    await expect(
      runMcpOauthCallbackRoute({
        provider: "eval-auth",
        state: "auth-session-1",
        code: "eval-auth-code",
      }),
    ).rejects.toThrow(
      'MCP OAuth callback route returned 200 without registering after() work for provider "eval-auth"',
    );
  });
});
