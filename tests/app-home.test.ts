import { describe, expect, it, vi } from "vitest";
import type { SectionBlock } from "@slack/web-api";
import { buildHomeView, publishAppHomeView } from "@/chat/app-home";
import type { UserTokenStore, StoredTokens } from "@/chat/credentials/user-token-store";

function createMockTokenStore(tokens: Record<string, StoredTokens | undefined>): UserTokenStore {
  return {
    get: vi.fn(async (_userId: string, provider: string) => tokens[provider]),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {})
  };
}

const validToken: StoredTokens = {
  accessToken: "xoxp-test",
  refreshToken: "xoxr-test",
  expiresAt: Date.now() + 3600_000
};

const expiredToken: StoredTokens = {
  accessToken: "xoxp-expired",
  refreshToken: "xoxr-expired",
  expiresAt: Date.now() - 1000
};

describe("buildHomeView", () => {
  it("shows connected oauth-bearer provider with Disconnect button", async () => {
    const store = createMockTokenStore({ sentry: validToken });
    const view = await buildHomeView("U123", store);

    expect(view.type).toBe("home");
    expect(view.blocks).toHaveLength(1);

    const section = view.blocks[0] as SectionBlock;
    expect(section.type).toBe("section");
    expect(section.text!.text).toContain("sentry");

    const accessory = section.accessory as { action_id: string; value: string };
    expect(accessory.action_id).toBe("app_home_disconnect");
    expect(accessory.value).toBe("sentry");
  });

  it("shows 'No connected accounts' when user has no tokens", async () => {
    const store = createMockTokenStore({});
    const view = await buildHomeView("U123", store);

    expect(view.type).toBe("home");
    expect(view.blocks).toHaveLength(1);

    const section = view.blocks[0] as SectionBlock;
    expect(section.text!.text).toBe("No connected accounts");
  });

  it("shows providers with expired access tokens (refresh token keeps connection alive)", async () => {
    const store = createMockTokenStore({ sentry: expiredToken });
    const view = await buildHomeView("U123", store);

    expect(view.blocks).toHaveLength(1);
    const section = view.blocks[0] as SectionBlock;
    expect(section.text!.text).toContain("sentry");
  });

  it("excludes github-app providers (no per-user auth)", async () => {
    // github-app tokens would never be in the user token store, but even if
    // the store returned something, buildHomeView skips non-oauth-bearer providers.
    const store = createMockTokenStore({ github: validToken });
    const view = await buildHomeView("U123", store);

    const section = view.blocks[0] as SectionBlock;
    expect(section.text!.text).toBe("No connected accounts");
    // github provider is github-app type, so store.get should not be called for it
    expect(store.get).not.toHaveBeenCalledWith("U123", "github");
  });
});

describe("publishAppHomeView", () => {
  it("calls views.publish with user_id and home view", async () => {
    const store = createMockTokenStore({ sentry: validToken });
    const mockClient = {
      views: {
        publish: vi.fn(async () => ({ ok: true }))
      }
    };

    await publishAppHomeView(mockClient as never, "U123", store);

    expect(mockClient.views.publish).toHaveBeenCalledOnce();
    expect(mockClient.views.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "U123",
        view: expect.objectContaining({
          type: "home",
          blocks: expect.arrayContaining([expect.anything()])
        })
      })
    );
  });
});
