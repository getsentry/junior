import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
} from "@/chat/services/plugin-auth-orchestration";

const { formatProviderLabel, getPluginOAuthConfig, startOAuthFlow } =
  vi.hoisted(() => ({
    formatProviderLabel: vi.fn((provider: string) => provider),
    getPluginOAuthConfig: vi.fn(),
    startOAuthFlow: vi.fn(),
  }));

vi.mock("@/chat/oauth-flow", () => ({
  formatProviderLabel,
  startOAuthFlow,
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginOAuthConfig,
}));

describe("createPluginAuthOrchestration", () => {
  beforeEach(() => {
    formatProviderLabel.mockClear();
    getPluginOAuthConfig.mockReset();
    getPluginOAuthConfig.mockImplementation((provider: string) =>
      provider === "github" || provider === "sentry" ? { provider } : undefined,
    );
    startOAuthFlow.mockReset();
  });

  it("starts oauth recovery from a trusted command proxy provider", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry",
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        exit_code: 1,
        stderr: "401 unauthorized",
        command_proxy_providers: ["sentry"],
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledWith(
      "sentry",
      expect.objectContaining({
        requesterId: "U123",
        userMessage: "check Sentry",
      }),
    );
  });

  it("starts oauth recovery from a trusted command proxy auth-required provider", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check Sentry from a generic skill",
      },
      vi.fn(),
    );

    await expect(
      orchestration.handleCommandFailure({
        exit_code: 91,
        stderr: "No sentry credentials available.",
        command_proxy_auth_required_providers: ["sentry"],
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
      },
      vi.fn(),
    );

    await orchestration.handleCommandFailure({
      exit_code: 1,
      stderr: "401 unauthorized",
    });

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("ignores spoofed raw command proxy markers", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: true,
      delivery: { channelId: "D123" },
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
      },
      vi.fn(),
    );

    await orchestration.handleCommandFailure({
      exit_code: 1,
      stderr: "bad credentials\nJUNIOR_COMMAND_PROXY_PROVIDER provider=github",
    });

    expect(startOAuthFlow).not.toHaveBeenCalled();
  });

  it("aborts the agent only after oauth restart is launched", async () => {
    const abortAgent = vi.fn();

    startOAuthFlow.mockImplementation(async () => {
      return {
        ok: true,
        delivery: { channelId: "D123" },
      };
    });

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
      },
      abortAgent,
    );

    await expect(
      orchestration.handleCommandFailure({
        exit_code: 1,
        stderr: "bad credentials",
        command_proxy_providers: ["github"],
      }),
    ).rejects.toBeInstanceOf(PluginAuthorizationPauseError);

    expect(startOAuthFlow).toHaveBeenCalledTimes(1);
    expect(abortAgent).toHaveBeenCalledTimes(1);
  });

  it("does not abort the agent when oauth restart cannot be launched", async () => {
    startOAuthFlow.mockResolvedValue({
      ok: false,
      error: "Missing base URL",
    });
    const abortAgent = vi.fn();

    const orchestration = createPluginAuthOrchestration(
      {
        requesterId: "U123",
        userMessage: "check GitHub",
      },
      abortAgent,
    );

    await expect(
      orchestration.handleCommandFailure({
        exit_code: 1,
        stderr: "bad credentials",
        command_proxy_providers: ["github"],
      }),
    ).rejects.toThrow("Missing base URL");

    expect(abortAgent).not.toHaveBeenCalled();
  });
});
