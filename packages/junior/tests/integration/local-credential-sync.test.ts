import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("local OAuth credential sync integration", () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      JUNIOR_SECRET: "test-secret",
      JUNIOR_STATE_ADAPTER: "memory",
      NODE_ENV: "development",
    };
    vi.resetModules();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    const { disconnectStateAdapter } = await import("@/chat/state/adapter");
    await disconnectStateAdapter();
    process.env = { ...ORIGINAL_ENV };
  });

  it("copies a signed credential into the dev-server token store", async () => {
    const credentialSync = await import("@/chat/local/credential-sync");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (input: URL | RequestInfo, init?: RequestInit) =>
          await credentialSync.receiveLocalOAuthCredential(
            new Request(input, init),
          ),
      ),
    );

    await credentialSync.syncLocalOAuthCredential("github", {
      accessToken: "ghu_local_user_token",
      expiresAt: Date.now() + 60 * 60_000,
      refreshToken: "ghr_local_refresh_token",
    });

    const { createUserTokenStore } =
      await import("@/chat/capabilities/factory");
    await expect(
      createUserTokenStore().get("local-cli", "github"),
    ).resolves.toMatchObject({
      accessToken: "ghu_local_user_token",
      refreshToken: "ghr_local_refresh_token",
    });
  });

  it("rejects a credential without a valid signature", async () => {
    const { receiveLocalOAuthCredential } =
      await import("@/chat/local/credential-sync");

    const response = await receiveLocalOAuthCredential(
      new Request(
        "http://127.0.0.1:3000/api/internal/local-oauth-credentials",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-junior-local-credential-signature": "invalid",
          },
          body: JSON.stringify({
            createdAtMs: Date.now(),
            provider: "github",
            tokens: { accessToken: "secret" },
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
  });

  it("does not accept credentials outside the local development server", async () => {
    const { receiveLocalOAuthCredential } =
      await import("@/chat/local/credential-sync");

    const publicResponse = await receiveLocalOAuthCredential(
      new Request(
        "https://junior.example/api/internal/local-oauth-credentials",
      ),
    );
    process.env.NODE_ENV = "production";
    const productionResponse = await receiveLocalOAuthCredential(
      new Request("http://127.0.0.1:3000/api/internal/local-oauth-credentials"),
    );

    expect(publicResponse.status).toBe(404);
    expect(productionResponse.status).toBe(404);
  });
});
