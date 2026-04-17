import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginAuthOrchestration,
  PluginAuthorizationPauseError,
} from "@/chat/services/plugin-auth-orchestration";
import type { Skill } from "@/chat/skills";

const {
  formatProviderLabel,
  getPluginDefinition,
  getPluginOAuthConfig,
  startOAuthFlow,
  unlinkProvider,
} = vi.hoisted(() => ({
  formatProviderLabel: vi.fn((provider: string) => provider),
  getPluginDefinition: vi.fn(),
  getPluginOAuthConfig: vi.fn(),
  startOAuthFlow: vi.fn(),
  unlinkProvider: vi.fn(),
}));

vi.mock("@/chat/oauth-flow", () => ({
  formatProviderLabel,
  startOAuthFlow,
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginDefinition,
  getPluginOAuthConfig,
}));

vi.mock("@/chat/credentials/unlink-provider", () => ({
  unlinkProvider,
}));

const githubSkill: Skill = {
  name: "github",
  description: "GitHub helper",
  skillPath: "/tmp/github",
  body: "instructions",
  pluginProvider: "github",
  allowedTools: ["bash"],
  usesConfig: ["github.repo"],
};

describe("createPluginAuthOrchestration", () => {
  beforeEach(() => {
    formatProviderLabel.mockClear();
    getPluginDefinition.mockReset();
    getPluginDefinition.mockReturnValue({
      manifest: {
        name: "github",
        credentials: {
          type: "github-app",
          apiDomains: ["api.github.com"],
          authTokenEnv: "GITHUB_TOKEN",
        },
      },
    });
    getPluginOAuthConfig.mockReset();
    getPluginOAuthConfig.mockReturnValue({ provider: "github" });
    startOAuthFlow.mockReset();
    unlinkProvider.mockReset();
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
        activeSkill: githubSkill,
        command: "gh issue view 123",
        details: {
          exit_code: 1,
          stderr: "bad credentials",
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
        activeSkill: githubSkill,
        command: "gh issue view 123",
        details: {
          exit_code: 1,
          stderr: "bad credentials",
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
        activeSkill: githubSkill,
        command: "curl https://other-api.example.test",
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
