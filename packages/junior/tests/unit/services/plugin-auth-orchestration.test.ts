import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
} from "@/chat/services/plugin-auth-orchestration";

const {
  formatProviderLabel,
  getPluginOAuthConfig,
  startOAuthFlow,
  unlinkProvider,
} = vi.hoisted(() => ({
  formatProviderLabel: vi.fn((provider: string) => provider),
  getPluginOAuthConfig: vi.fn(),
  startOAuthFlow: vi.fn(),
  unlinkProvider: vi.fn(),
}));

vi.mock("@/chat/oauth-flow", () => ({
  formatProviderLabel,
  startOAuthFlow,
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig,
}));

vi.mock("@/chat/credentials/unlink-provider", () => ({
  unlinkProvider,
}));

describe("createPluginAuthOrchestration", () => {
  beforeEach(() => {
    formatProviderLabel.mockClear();
    getPluginOAuthConfig.mockReset();
    getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" || provider === "sentry" ? { provider } : undefined,
    );
    startOAuthFlow.mockReset();
    unlinkProvider.mockReset();
  });

  it("starts oauth recovery from command proxy provider markers", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const userTokenStore = {} as any;
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
        userTokenStore,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        details: {
          exit_code: 1,
          stderr:
            "401 unauthorized\nJUNIOR_COMMAND_PROXY_PROVIDER provider=sentry",
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "check Sentry",
      }),
    );
    expect(unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "sentry",
      userTokenStore,
    );
  });

  it("starts oauth recovery from command proxy auth markers without an active skill", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        details: {
          exit_code: 91,
          stderr:
            "No sentry credentials available.\nJUNIOR_COMMAND_PROXY_AUTH_REQUIRED provider=sentry",
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
      }),
    );
  });

  it("ignores auth-like failures without command proxy markers", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await orchestration.handleCommandFailure({
      details: {
        exit_code: 1,
        stderr: "401 unauthorized",
      },
    });

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("unlinks the stored token only after oauth restart is launched", async () => {
    const order: string[] = [];
    const userTokenStore = {} as any;
    const abortAgent = vi.fn();

    startOAuthFlow.mockImplementation(async () => {
      order.push("oauth");
      return {
        ok: true,
        delivery: { channelId: "D123" },
      };
    });
    unlinkProvider.mockImplementation(async () => {
      order.push("unlink");
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore,
      },
      abortAgent,
    );

    await expect(
      orchestration.handleCommandFailure({
        details: {
          exit_code: 1,
          stderr:
            "bad credentials\nJUNIOR_COMMAND_PROXY_PROVIDER provider=github",
        },
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(order).toEqual(["oauth", "unlink"]);
    expect(unlinkProvider).toHaveBeenCalledWith(
      "U123",
      "github",
      userTokenStore,
    );
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("keeps the stored token when oauth restart cannot be launched", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: false,
      error: "Missing base URL",
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        details: {
          exit_code: 1,
          stderr:
            "bad credentials\nJUNIOR_COMMAND_PROXY_PROVIDER provider=github",
        },
      }),
    ).rejects.toThrow("Missing base URL");

    expect(unlinkProvider).not.toHaveBeenCalled();
  });

  it("ignores auth-like failures for commands unrelated to the provider", async () => {
    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
        userTokenStore: {} as any,
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        details: {
          exit_code: 1,
          stderr: "401 unauthorized",
        },
      }),
    ).resolves.toBeUndefined();

    expect(startOAuthFlow).not.toHaveBeenCalled();
    expect(unlinkProvider).not.toHaveBeenCalled();
  });
});
