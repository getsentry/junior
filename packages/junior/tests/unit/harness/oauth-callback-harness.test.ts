import { afterEach, describe, expect, it, vi } from "vitest";

const { routerGetMock } = vi.hoisted(() => ({
  routerGetMock: vi.fn(),
}));

vi.mock("@/handlers/router", () => ({
  GET: routerGetMock,
}));

import { runOauthCallbackRoute } from "../../fixtures/oauth-callback-harness";

describe("oauth callback harness", () => {
  afterEach(() => {
    routerGetMock.mockReset();
  });

  it("fails when the callback route returns success without registering after() work", async () => {
    routerGetMock.mockResolvedValue(new Response("ok", { status: 200 }));

    await expect(
      runOauthCallbackRoute({
        provider: "eval-oauth",
        state: "oauth-state-1",
        code: "eval-oauth-code",
      }),
    ).rejects.toThrow(
      'OAuth callback route returned 200 without registering after() work for provider "eval-oauth"',
    );
  });
});
