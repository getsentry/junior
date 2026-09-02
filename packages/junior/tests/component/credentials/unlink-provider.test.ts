import { describe, expect, it, vi } from "vitest";
import type { InstallationTokenStore } from "@/chat/credentials/installation-token-store";
import type { UserTokenStore } from "@/chat/credentials/user-token-store";

const { isSlackWorkspaceAdmin } = vi.hoisted(() => ({
  isSlackWorkspaceAdmin: vi.fn(),
}));

vi.mock("@/chat/slack/admin", () => ({ isSlackWorkspaceAdmin }));
vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getOAuthConfig: (provider: string) =>
      provider === "linear" ? { tokenSubject: "installation" } : {},
  },
}));

import { unlinkProvider } from "@/chat/credentials/unlink-provider";

function stores() {
  const userTokenStore: UserTokenStore = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    withRefresh: vi.fn(async (_userId, _provider, callback) => callback()),
  };
  const installationTokenStore: InstallationTokenStore = {
    get: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    withRefresh: vi.fn(async (_provider, callback) => callback()),
  };
  return { installationTokenStore, userTokenStore };
}

describe("unlinkProvider", () => {
  it("lets a Slack admin disconnect an installation", async () => {
    isSlackWorkspaceAdmin.mockResolvedValue(true);
    const { installationTokenStore, userTokenStore } = stores();

    await unlinkProvider(
      "U123",
      "linear",
      userTokenStore,
      installationTokenStore,
      "T123",
    );

    expect(installationTokenStore.delete).toHaveBeenCalledWith("linear");
    expect(userTokenStore.delete).not.toHaveBeenCalled();
  });

  it("does not let a non-admin disconnect an installation", async () => {
    isSlackWorkspaceAdmin.mockResolvedValue(false);
    const { installationTokenStore, userTokenStore } = stores();

    await expect(
      unlinkProvider(
        "U123",
        "linear",
        userTokenStore,
        installationTokenStore,
        "T123",
      ),
    ).rejects.toThrow("Only a Slack workspace admin");

    expect(installationTokenStore.delete).not.toHaveBeenCalled();
  });
});
